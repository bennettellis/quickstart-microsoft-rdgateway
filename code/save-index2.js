"use strict";

const AWS = require("aws-sdk");
const autoscaling = new AWS.AutoScaling();
const ddb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();
const systemsManager = new AWS.SSM();


// DynamoDB table where configuration is kept
const managementTable = process.env.TABLE_NAME;
// SNS topic that we send messages to (doesn't have to be the same as the SNS queue for LifeCycleHooks but simpler).
const snsTopicArn = process.env.SNS_TOPIC_ARN;

// types of RDS components
const GATEWAY = "RDS-Gateway";
const BROKER = "RDS-Connection-Broker";
const WEB = "RDS-Web-Access";

// STATUS of Instances in DynamoDB
const NEW = "New";
const CONFIGURED = "Configured";
const CONFIGURING = "Configuring";
const REMOVING = "Removing";

// STATUS of configuration commands sent to
const PENDING = "Pending";
const INPROGRESS = "InProgress";
const DELAYED = "Delayed";
const SUCCESS = "Success";
const CANCELLED = "Cancelled";
const TIMEDOUT = "TimedOut";
const FAILED = "Failed";
const CANCELLING = "Cancelling";


const DEFAULT_DELAY = 30000;


/**
 * Main handler determines how to handle event and delegates
 * @param event
 * @param context
 * @param callback
 * @returns {Promise<void>}
 */
module.exports.handler = async(event, context, callback) => {
  try {
    let message;
    if (!managementTable) throw Error("Value for environment variable TABLE_NAME is missing");
    if (!snsTopicArn) throw Error("Value for SNS Topic to send notifications to is missing");
    console.log(JSON.stringify(event));
    if (event.Records) {
      await Promise.all(event.Records.map(async rec => {
          const parsedMessage = JSON.parse(rec.Sns.Message);
          console.log(`Parsed Message was:\n${JSON.stringify(parsedMessage, null, 2)}`);
          if (parsedMessage.StatusCheck) {
            console.log(`Handling status check event from Lambda...`);
            return handleStatusCheck(parsedMessage);
          } else if (parsedMessage.WorkspaceId) {
            console.log(`Handling workspace event...`);
            message = await handleWorkspaceEvent(parsedMessage);
            return Promise.resolve("Workspace Addition Skipped!");
          } else if (parsedMessage.LifecycleHookName) {
            console.log(`Handling scaling event from autoscaling with LifeCycleHook...`);
            return handleLifeCycleEvent(parsedMessage);
          } else {
            return Promise.resolve(Error("No way to deal with message"));
          }
        }))
        .then(results => {
          console.log(JSON.stringify(results, null, 2));
          message = `${event.Records.length} messages processed.`;
        });
    } else {
      message = `Event does not contain "Records" attribute. Not sure how to handle. Skipping!`;
    }
    console.log(message);
    callback(null, message);
  } catch (err) {
    console.log(err);
    callback(err);
  }
};


/**
 * Handles an autoscaling LifeCycleHook event (Launching or Terminating) and initiates configuration actions based on the event
 * @param event
 * @returns {Promise<void>}
 */
async function handleLifeCycleEvent(event) {
  // received message of scale. Check DB for "Primary Connection Broker" of the deployment
  const deployment = getDeployment();
  if (/LAUNCHING$/i.test(event.LifecycleHookName)) {
    console.log("Instance is LAUNCHING.");
    await addInstanceToDeployment(event, deployment);
  } else if (/TERMINATING/i.test(event.LifecycleHookName)) {
    console.log("Instance is TERMINATING");
    await removeInstanceFromDeployment(event, deployment);
  } else {
    console.log(`Unknown LifeCycleHook Name. Should end in either LAUNCHING or TERMINATING (LifeCycleHookName: ${event.LifecycleHookName}). Skipping!`);
  }
}


/**
 * Gets the instance data that we have from the deployment extracted from DDB
 *
 *
 */
function findInstanceInDeployment(instanceId, deployment) {
  return deployment.AllMembersList.find(inst => inst.InstanceId === instanceId);
}



/**
 * Handles a "status check" event from this lambda in order to wait for configuration completions
 * @param event
 * @returns {Promise<void>}
 */
async function handleStatusCheck(event) {
  // check status of all existing commands run against the instance
  const status = await getConfigurationStatus(event.EC2InstanceId);
  const deployment = await getDeployment();
console.log(JSON.stringify(deployment, null, 2));
  // STATUS of configuration commands sent to
  switch (status) {
    case SUCCESS:
      console.log(`Configuration status for ${event.EC2InstanceId}: ${status}. Signaling 'CONTINUE' for LifeCycleHook ${event.LifecycleHookName}.`);
      // Complete the LifeCycle Action (CONTINUE)
      await autoscaling.completeLifecycleAction({
        LifecycleHookName: event.LifecycleHookName, AutoScalingGroupName: event.AutoScalingGroupName,
        LifecycleActionToken: event.LifecycleActionToken, LifecycleActionResult: 'CONTINUE'
      }).promise().catch(err => console.log(err));
      await recordInstanceInDDB(Object.assign(findInstanceInDeployment(event.EC2InstanceId, deployment), {Status: CONFIGURED}));
      // at this point the instance is fully added or removed from the Deployment
      break;
    case INPROGRESS:
    case PENDING:
    case DELAYED:
      console.log(`Configuration status for ${event.EC2InstanceId}: ${status}. Sleeping for 30 seconds...`);
      await wait(DEFAULT_DELAY);
      await publishSNSMessage(event, snsTopicArn);
      // at this point the addition or removal of the instance is "in progress" and will be checked by next message
      break;
    case FAILED:
    case CANCELLED:
    case CANCELLING:
    case TIMEDOUT:
      console.log(`Configuration status for ${event.EC2InstanceId}: ${status}. Signaling 'ABANDON' for LifeCycleHook ${event.LifecycleHookName}.`);
      await autoscaling.completeLifecycleAction({
        LifecycleHookName: event.LifecycleHookName, AutoScalingGroupName: event.AutoScalingGroupName,
        LifecycleActionToken: event.LifecycleActionToken, LifecycleActionResult: 'ABANDON'
      }).promise().catch(err => console.log(err));
      await recordInstanceInDDB(Object.assign(findInstanceInDeployment(event.EC2InstanceId, deployment), {Status: REMOVING}));
      break;
    default:
      console.log(`Result of checking configuration state on instance `);
  }
}



/**
 * Records data for the instance in DynamoDB table
 * @param InstanceData
 * @returns {Promise<DocumentClient.PutItemOutput,WSError>}
 */
function recordInstanceInDDB(InstanceData) {
  // crete or update the item in the table. Only supplied data values will be changed. Existing data will be preserved.
  return ddb.put({TableName: managementTable, Item: InstanceData}).promise();
}

/**
 * Simple wait function to delay whenever needed.
 * @param ms milliseconds to wait
 * @returns {Promise<undefined>}
 */
async function wait(ms) {
  return await new Promise((resolve)=>setTimeout(resolve, ms));
}

async function addWorkspaceToDeployment(event, deployment) {
  console.log(`Initiated addition of Workspace ${event.WorkspaceId} to deployment.`);
  await wait(DEFAULT_DELAY);
  await publishSNSMessage(Object.assign({StatusCheck: true}, event), snsTopicArn);

}

async function removeWorkspaceFromDeployment(event, deployment) {
  console.log(`Initiated removal of Workspace ${event.WorkspaceId} to deployment.`);
  await wait(DEFAULT_DELAY);
  await publishSNSMessage(Object.asign({StatusCheck: true}, event), snsTopicArn);

}

/**
 * Publishes SNS Notification to SNS Queuq
 * @param snsMessage the message to publish
 * @param snsTopicArn the SNS Topic ARN
 * @returns {Promise<PromiseResult<SNS.PublishResponse, AWSError>>}
 */
function publishSNSMessage(snsMessage,snsTopicArn) {
  console.log(`PUBLISHING SNS Message:\n${JSON.stringify(snsMessage, null, 2)}`);
  return sns.publish({TopicArn: snsTopicArn, Message: JSON.stringify(snsMessage)}).promise()
    .catch(err => {
      console.log(err);
    });
}


/**
 * Get the deployment as marked in the database. Does not include items being REMOVED
 * @returns {Promise<{ PrimaryBroker: {}, BrokerList: [], GatewayList: [], WebAccessList: []}>}
 */
async function getDeployment() {
  const params = {TableName: managementTable,
    //AttributesToGet: ["InstanceId", "Type", "Primary", "Status"],
    // FilterExpression : 'Status != :removing',
    // ExpressionAttributeValues : {':removing' : REMOVING},
    ConsistentRead: true // force consistent read so we know we have latest updates in hand
  };
  const members = [];
  let done = false;
  while (!done) {
    const data = await ddb.scan(params).promise();
    members.push(...data.Items);
    if (data.LastEvaluatedKey) {
      params.ExclusiveStartKey = data.LastEvaluatedKey;
    } else {
      done = true;
    }
  }
  return members.reduce((acc, member) => {
    if (!/remov/i.test(member.Status)) {
      switch (member.Type) {
        case BROKER:
          acc.BrokerList.push(member);
          if (member.PrimaryBroker === true) {
            if (acc.PrimaryBroker) {
              throw Error(`Encountered two Connection Brokers both marked as primary!! (${member.InstanceId}, ${acc.PrimaryBroker.InstanceId})`);
            }
            acc.PrimaryBroker = member;
          }
          break;
        case WEB:
          acc.WebAccessList.push(member);
          break;
        case GATEWAY:
          acc.GatewayList.push(member);
          break;
        default:
          throw Error(`Encountered unexpected component type ${member.Type} in deployment tracking data. Must be corrected to continue`);
      }
      acc.AllMembersList.push(member);
    }
    return acc;
  }, { PrimaryBroker: null, BrokerList: [], GatewayList: [], WebAccessList: [], AllMembersList: []});
}


/**
 * Gets the Configuration Status of an instance
 * @param InstanceId
 * @returns {Promise<string>}
 */
async function getConfigurationStatus(InstanceId) {
  // check if this instance is in "ready" state
  const TaskStatuses = await getTaskStatusForInstance(InstanceId);
  if (TaskStatuses.Success === TaskStatuses.Total) {
    return SUCCESS;
  } else if (TaskStatuses.Failed > 0) {
    return FAILED;
  } else if (TaskStatuses.Cancelled > 0) {
    return CANCELLED;
  } else if (TaskStatuses.Cancelling > 0) {
    return CANCELLING;
  } else if (TaskStatuses.TimedOut > 0) {
    return TIMEDOUT;
  } else if (TaskStatuses.InProgress > 0) {
    return INPROGRESS;
  } else if (TaskStatuses.Pending > 0) {
    return PENDING;
  } else if (TaskStatuses.Delayed > 0) {
    return DELAYED;
  }
}



function getTaskStatusForInstance(InstanceId) {
  return systemsManager.listCommandInvocations({InstanceId}).promise()
    .then(result => {
      return result.CommandInvocations.reduce((acc, inv) => {
        acc[inv.Status] += 1;
        acc.Total += 1;
        return acc;
      }, { Pending: 0, InProgress: 0, Delayed: 0, Success: 0, Cancelled: 0, TimedOut: 0, Failed: 0, Cancelling: 0, Total: 0 });
    });
}



/**
 * Adds the specified instance to the RDS Deployment
 * @param event
 * @param deployment
 * @returns {Promise<void>}
 */
async function addInstanceToDeployment(event, deployment) {
  const Type = event.LifecycleHookName.replace("-LAUNCHING", "");
  const InstanceId = event.EC2InstanceId;
  console.log(`Type of component being added is ${Type}. Instance is ${event.EC2InstanceId}`);
  if (deployment.PrimaryBroker && deployment.PrimaryBroker.Status !== CONFIGURED) {
    console.log("Primary connection broker configuration in progress. Waiting for primary broker configuration to complete.");
    // can't continue until primary broker is configured.
    await wait(DEFAULT_DELAY);
    await publishSNSMessage(event, snsTopicArn);
  } else if (!deployment.PrimaryBroker && Type === BROKER ) {
    // no primary broker, make this one primary if possible
    let thisBrokerIsPrimary = false;
    try {
      await recordInstanceInDDB({InstanceId, Type, PrimaryBroker: true, Status: NEW});
      const tempDeployment = await getDeployment();
      console.log(`When checking for RACE CONDITION, DEPLOYMENT IS: ${JSON.stringify(tempDeployment, null,2)}`);
      // if no error (getDeployment throws error if it encounters two primary brokers
      thisBrokerIsPrimary = true;
    } catch (err) {
      // set it back to not primary
      await recordInstanceInDDB({InstanceId, Type, PrimaryBroker: false, Status: NEW});
      // get the deployment that should succeed with a single primary broker now.
      const tempDeployment = await getDeployment();
      console.log(`Encountered race condition for primary connection broker. 
              Backing off for instance ${InstanceId} and allowing instance ${tempDeployment.PrimaryBroker.InstanceId} to be primary`);
      // set primary to FALSE
      await wait(DEFAULT_DELAY);
    }
    if (thisBrokerIsPrimary) {
      // THIS BROKER IS NOW PRIMARY
      await initPrimaryBrokerConfig(InstanceId);
      console.log(`Initiated creation of RDS Deployment with Primary Broker ${InstanceId}.`);
      await wait(DEFAULT_DELAY);
      await publishSNSMessage(Object.assign({StatusCheck: true}, event), snsTopicArn);
    }
  } else {
    // Primary Broker exists and is configured
    switch (Type) {
      case GATEWAY:
        await recordInstanceInDDB({InstanceId, Type, Status: NEW});
        await initGatewayConfig(InstanceId, deployment.PrimaryBroker.InstanceId);
        break;
      case WEB:
        await recordInstanceInDDB({InstanceId, Type, Status: NEW});
        await initWebAccessConfig(InstanceId, deployment.PrimaryBroker.InstanceId);
        break;
      case BROKER:
        await recordInstanceInDDB({InstanceId, Type, PrimaryBroker: false, Status: NEW});
        await initBrokerConfig(InstanceId, deployment.PrimaryBroker.InstanceId);
        break;
      default:
        throw Error(`Specified type (${Type} is not known Remote Desktop Component type`);

    }
    console.log(`Initiated addition of Instance ${InstanceId} as ${Type} to deployment.`);
    await wait(DEFAULT_DELAY);
    await publishSNSMessage(Object.assign({StatusCheck: true}, event), snsTopicArn);
  }
}

//deployment.GatewayList.splice(idx, 1);

/**
 * Removes the instance from the Deployment
 * @param type the type of RDS component that is being removed.
 * @param instanceId the instance to remove
 * @param deployment object containing inforamtion about the deployment
 * @returns {Promise<void>}
 */
async function removeInstanceFromDeployment(event, deployment) {
  const Type = event.LifecycleHookName.replace("-TERMINATING", "");
  const InstanceId = event.EC2InstanceId;
  console.log(`Type of component being removed is ${Type}. Instance is ${InstanceId}`);
  if (deployment.PrimaryBroker && deployment.PrimaryBroker.Status === CONFIGURING) {
    console.log("Primary connection broker configuration in progress. Cannot remove instance from non-existent deployment.");
    // can't continue until primary broker is configured.
    await wait(DEFAULT_DELAY);
    await publishSNSMessage(event, snsTopicArn);
  } else {
    switch (Type) {
      case GATEWAY:
        await recordInstanceInDDB({InstanceId, Type, Status: REMOVING});
        await initGatewayRemoval(InstanceId);
        break;
      case WEB:
        await recordInstanceInDDB({InstanceId, Type, Status: REMOVING});
        await initWebAccessRemoval(InstanceId);
        break;
      case BROKER:
        await recordInstanceInDDB({InstanceId, Type, Status: REMOVING});
        await initBrokerRemoval(InstanceId);
        break;
      default:
        throw Error(`Specified type (${Type} is not known Remote Desktop Component type`);
    }
  }
  console.log(`Initiated removal of Instance ${InstanceId} of ${Type} from deployment.`);
  await wait(DEFAULT_DELAY);
  await publishSNSMessage(Object.assign({StatusCheck: true}, event), snsTopicArn);
}



async function initPrimaryBrokerConfig(instanceID) {

}

async function initBrokerConfig(instanceId) {

}

async function initGatewayConfig(instanceId) {

}

async function initWebAccessConfig(instanceId) {

}

async function initPrimaryBrokerChange(instanceID) {

}

async function initBrokerRemoval(instanceId) {

}

async function initGatewayRemoval(instanceId) {

}

async function initWebAccessRemoval(instanceId) {
  //systemsManager.sendCommand({DocumentName: "RemoveGatewayFromRDS", InstanceIds: [PrimaryBrokerInstanceId]})

}