"use strict";

const AWS = require('aws-sdk');
const ec2 = new AWS.EC2();
const autoscaling = new AWS.AutoScaling();
const sns = new AWS.SNS();
// const ddb = new AWS.DynamoDB.DocumentClient();
const systemsManager = new AWS.SSM();
const crypto = require("crypto");

// DynamoDB table where configuration is kept
const managementTable = process.env.TABLE_NAME;
// SNS topic that we send messages to (doesn't have to be the same as the SNS queue for LifeCycleHooks but simpler).
const snsTopicArn = process.env.SNS_TOPIC_ARN;
const rdsDeploymentName = process.env.RDS_DEPLOYMENT_NAME;

// types of RDS components
const GATEWAY = "RDS-Gateway";
const BROKER = "RDS-Connection-Broker";
const WEB = "RDS-Web-Access";

// STATUS of Instances in DynamoDB
const NEW = "New";
const CONFIGURED = "Configured";
const CONFIGURING = "Configuring";
const REMOVING = "Removing";
const REMOVED = "Removed";

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
    if (!snsTopicArn) throw Error("Value for SNS_TOPIC_ARN to send notifications to is missing");
    if (!rdsDeploymentName) throw Error("Value for RDS_DEPLOYMENT_NAME is missing.")
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
 * Handles a "status check" event from this lambda in order to wait for configuration completions
 * @param event
 * @returns {Promise<void>}
 */
async function handleStatusCheck(event) {
  // check status of all existing commands run against the instance
  const jobStatus = await getConfigurationStatus(event.EC2InstanceId);
  const deployment = await getDeployment();
console.log(JSON.stringify(deployment, null, 2));
  // STATUS of configuration commands sent to
  switch (jobStatus) {
    case SUCCESS:
      console.log(`Configuration status for ${event.EC2InstanceId}: ${jobStatus}. Signaling 'CONTINUE' for LifeCycleHook ${event.LifecycleHookName}.`);
      // Complete the LifeCycle Action (CONTINUE)
      await autoscaling.completeLifecycleAction({
        LifecycleHookName: event.LifecycleHookName, AutoScalingGroupName: event.AutoScalingGroupName,
        LifecycleActionToken: event.LifecycleActionToken, LifecycleActionResult: 'CONTINUE'
      }).promise().catch(err => console.log(err));
      const Status = (/-TERMINAT/i.test(event.LifecycleHookName)) ? REMOVED : CONFIGURED;
      await setDeploymentMember({InstanceId: event.EC2InstanceId, Status});
      // at this point the instance is fully added or removed from the Deployment
      break;
    case INPROGRESS:
    case PENDING:
    case DELAYED:
      console.log(`Configuration status for ${event.EC2InstanceId}: ${jobStatus}. Sleeping for 30 seconds...`);
      await wait(DEFAULT_DELAY);
      await publishSNSMessage(event, snsTopicArn);
      // at this point the addition or removal of the instance is "in progress" and will be checked by next message
      break;
    case FAILED:
    case CANCELLED:
    case CANCELLING:
    case TIMEDOUT:
      console.log(`Configuration status for ${event.EC2InstanceId}: ${jobStatus}. Signaling 'ABANDON' for LifeCycleHook ${event.LifecycleHookName}.`);
      await autoscaling.completeLifecycleAction({
        LifecycleHookName: event.LifecycleHookName, AutoScalingGroupName: event.AutoScalingGroupName,
        LifecycleActionToken: event.LifecycleActionToken, LifecycleActionResult: 'ABANDON'
      }).promise().catch(err => console.log(err));
      await setDeploymentMember({InstanceId: event.EC2InstanceId, Status: REMOVING});
      break;
    default:
      console.log(`Result of checking configuration state on instance could not be determined: ${jobStatus}`);
  }
}


/**
 * Handles an autoscaling LifeCycleHook event (Launching or Terminating) and initiates configuration actions based on the event
 * @param event
 * @returns {Promise<void>}
 */
async function handleWorkspaceEvent(event) {
  // received message of scale. Check DB for "Primary Connection Broker" of the deployment
  const deployment = getDeployment();
  if (/CREATED$/i.test(event.detail.Action)) {
    console.log(`Workspace Created. ID is ${event.WorkspaceId}`);
    await addWorkspaceToDeployment(event.detail.WorkspaceId, deployment);
  } else if (/STOP/i.test(event.detail.Action)) {
    console.log(`Workspace STOPPED. ID is ${event.WorkspaceId}`);
    await removeWorkspaceFromDeployment(event.WorkspaceId, deployment);
  } else {
    console.log(`Unknown ACTION in Workspace Event. Should end in either CREATE or STOP (WorkspaceId: ${event.WorkspaceId}). Skipping!`);
  }
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
 * Get the deployment as marked in the database. Does not include items being REMOVED
 * @returns {Promise<{ PrimaryBroker: {}, BrokerList: [], GatewayList: [], WebAccessList: []}>}
 */
async function getDeployment() {
  console.log(`Getting Deployment information for deployment named: ${rdsDeploymentName}`);
  const deploymentParam = await systemsManager.getParameter({Name: rdsDeploymentName, WithDecryption: true}).promise()
    .catch(err => {
      if (err.code === "ParameterNotFound") {
        console.log("Deployment not set yet, setting up...");
        const deployment = [];
        //deployment has not been setup yet. Set it.
        return systemsManager.putParameter({
          Name: rdsDeploymentName,
          Type: "String",
          Value: JSON.stringify(deployment)
        }).promise()
          .then(() => {
            //try again
            return systemsManager.getParameter({Name: rdsDeploymentName}).promise();
          });
      } else {
        throw err;
      }
    });
  const deploymentList = JSON.parse(deploymentParam.Parameter.Value);
  return deploymentList.reduce((acc, member) => {
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
 * Grab the conch. Always expires in one minute.
 * @returns {Promise<string>}
 */
async function grabConch() {
  const conchToken = crypto.randomBytes(16).toString("hex");
  let obtained = false;
  while(!obtained) {
    try {
      const conch = await systemsManager.getParameter({Name: rdsDeploymentName + "-Conch"}).promise();
      const [existingToken, expiration] = conch.Parameter.Value.split(",");
      if (existingToken === conchToken) {
        console.log(`Got conch! (token: ${conchToken}`);
        obtained = true;
        return conchToken;
      } else if ((new Date(expiration) - new Date()) <= 0) {
        // conch reservation has expired. remove.
        console.log(`conch reservation for token ${existingToken} expired at ${expiration}. Releasing forcibly!`);
        await systemsManager.deleteParameter({Name: rdsDeploymentName + "-Conch"}).promise();
        await wait( 100 );
      } else {
        console.log("waiting for conch to become available....");
        await wait(Math.random() + 1000);
      }
    } catch(err) {
      if (err.code === "ParameterNotFound") {
        // sets up expiration in 1 minute (shouldn't hold conch for longer than a few seconds,
        // so this is to trap any dangling conch reservations)
        const expirationTime = new Date((new Date()).getTime() + 60000);
        console.log("Attempting to grab conch...")
        try {
          await systemsManager.putParameter({
            Overwrite: false,
            Name: rdsDeploymentName + "-Conch",
            Type: "String",
            Value: `${conchToken},${expirationTime.toISOString()}`
          }).promise();
        } catch(err2) {
          // try again ...
          console.log("Attempt to grab conch trumped. Will retry.");
          await wait(Math.random() + 1000);
        }
      }
    }
  }
}


/**
 * Releases the conch specified by token. If conch reservation has expired, gracefully does nothing.
 * @param conchToken
 * @returns {Promise<void>}
 */
async function releaseConch(conchToken) {
  try {
    console.log(`Attempting to release conch ${conchToken}`);
    const conch = await systemsManager.getParameter({Name: rdsDeploymentName + "-Conch"}).promise();
    const [existingToken] = conch.Parameter.Value.split(",");
    if (existingToken === conchToken) {
      await systemsManager.deleteParameter({Name: rdsDeploymentName + "-Conch"}).promise();
      console.log(`Released conch with tokent ${conchToken}`);
    } else {
      console.log(`Conch with token ${conchToken} is not current. May have expired before being release and obtained by another process. Conch found was ${existingToken}`);
    }
  } catch (err) {
    if (err.code === "ParameterNotFound") {
      console.log(`Conch with token ${conchToken} looks to have expired before being released. May need to increase reservation time.`);
      return Promise.resolve();
    }
    throw err;
  }
}


/**
 * Get the deployment as marked in the database. Does not include items being REMOVED
 * @returns {Promise<{ PrimaryBroker: {}, BrokerList: [], GatewayList: [], WebAccessList: []}>}
 */
async function setDeploymentMember(memberData) {
  const conchToken = await grabConch();
  const deployment = await getDeployment();
  if (memberData.Type === BROKER &&
      memberData.PrimaryBroker === true &&
      deployment.PrimaryBroker &&
      deployment.PrimaryBroker.InstanceId !== memberData.InstanceId) {
      await releaseConch(conchToken);
      throw Error("Attempting to add primary broker when we already have one!!!");
  }
  const existingMember = deployment.AllMembersList.find(inst => inst.InstanceId === memberData.InstanceId);
  if (existingMember) {
    Object.assign(existingMember, memberData);
  } else {
    deployment.AllMembersList.push(memberData);
  }
  const params = {
    Name: rdsDeploymentName,
    Overwrite: true,
    Type: "String",
    Value: JSON.stringify(deployment.AllMembersList)
  };
  await systemsManager.putParameter(params).promise();
  await wait(100);
  console.log(`Completed setting member data: ${JSON.stringify(memberData)}`);
  await releaseConch(conchToken);
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
  console.log(`Type of component being added is ${Type}. Instance is ${InstanceId}`);
  if (deployment.PrimaryBroker && deployment.PrimaryBroker.Status !== CONFIGURED) {
    console.log("Primary connection broker configuration in progress. Waiting for primary broker configuration to complete.");
    // can't continue until primary broker is configured.
    await wait(DEFAULT_DELAY);
    await publishSNSMessage(event, snsTopicArn);
  } else if (!deployment.PrimaryBroker && Type === BROKER ) {
    // no primary broker, make this one primary if possible
    console.log(`Deployment does not have a primary broker, so establishing this one as primary: ${InstanceId}`);
    let thisBrokerIsPrimary = false;
    try {
      await setDeploymentMember({InstanceId, Type, PrimaryBroker: true, Status: NEW});
      const tempDeployment = await getDeployment();
      console.log(`When checking for RACE CONDITION, DEPLOYMENT IS: ${JSON.stringify(tempDeployment, null,2)}`);
      // if no error (getDeployment throws error if it encounters two primary brokers
      thisBrokerIsPrimary = true;
    } catch (err) {
      // set it back to not primary
      await setDeploymentMember({InstanceId, Type, PrimaryBroker: false, Status: NEW});
      // get the deployment that should succeed with a single primary broker now.
      const tempDeployment = await getDeployment();
      console.log(`Encountered race condition for primary connection broker. 
              Backing off for instance ${InstanceId} and allowing instance ${tempDeployment.PrimaryBroker.InstanceId} to be primary`);
      // set primary to FALSE
      await wait(DEFAULT_DELAY);
      await publishSNSMessage(event, snsTopicArn);
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
        await setDeploymentMember({InstanceId, Type, Status: NEW});
        await initGatewayConfig(InstanceId, deployment.PrimaryBroker.InstanceId);
        break;
      case WEB:
        await setDeploymentMember({InstanceId, Type, Status: NEW});
        await initWebAccessConfig(InstanceId, deployment.PrimaryBroker.InstanceId);
        break;
      case BROKER:
        await setDeploymentMember({InstanceId, Type, PrimaryBroker: false, Status: NEW});
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
 * @param event
 * @param deployment object containing information about the deployment
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
        await setDeploymentMember({InstanceId, Type, Status: REMOVING});
        await initGatewayRemoval(InstanceId);
        break;
      case WEB:
        await setDeploymentMember({InstanceId, Type, Status: REMOVING});
        await initWebAccessRemoval(InstanceId);
        break;
      case BROKER:
        await setDeploymentMember({InstanceId, Type, Status: REMOVING});
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

async function addWorkspaceToDeployment(event, deployment) {
  console.log(`Initiated addition of Workspace ${event.WorkspaceId} to deployment.`);
  await wait(DEFAULT_DELAY);
  await publishSNSMessage(Object.assign({StatusCheck: true}, event), snsTopicArn);

}

async function removeWorkspaceFromDeployment(event, deployment) {
  console.log(`Initiated removal of Workspace ${event.WorkspaceId} to deployment.`);
  await wait(DEFAULT_DELAY);
  await publishSNSMessage(Object.assign({StatusCheck: true}, event), snsTopicArn);

}

// /**
//  * Records data for the instance in DynamoDB table
//  * @param InstanceData
//  * @returns {Promise<DocumentClient.PutItemOutput, AWSError>}
//  */
// function recordInstanceInDDB(InstanceData) {
//   // crete or update the item in the table. Only supplied data values will be changed. Existing data will be preserved.
//   return ddb.put({TableName: managementTable, Item: InstanceData}).promise();
// }


/**
 * Checks the state of the instance to ensure that it is actually in a running state.
 * @param InstanceId
 * @returns {Promise<EC2.DescribeInstanceStatusResult, AWSError>}
 */
function isInstanceRunning(InstanceId) {
  // check instance state. Must be "pending..." or "running"
  return ec2.describeInstanceStatus({InstanceIds: [InstanceId]}).promise()
    .then(result => {
      if (result.InstanceStatuses.length > 0) {
        const status = result.InstanceStatuses[0].InstanceState;
        console.log(`Got Status from EC2 Instance ${InstanceId}: ${status.Name}`);
        return (/^(running|pending)/i.test(status.Name));
      }
    });
}


/**
 * Publishes SNS Notification to SNS Queuq
 * @param snsMessage the message to publish
 * @param snsTopicArn the SNS Topic ARN
 * @returns {Promise<SNS.PublishResponse, AWSError>}
 */
function publishSNSMessage(snsMessage,snsTopicArn) {
  console.log(`PUBLISHING SNS Message:\n${JSON.stringify(snsMessage, null, 2)}`);
  return sns.publish({TopicArn: snsTopicArn, Message: JSON.stringify(snsMessage)}).promise()
    .catch(err => {
      console.log(err);
    });
}

async function initPrimaryBrokerConfig(instanceID) {

}

async function initBrokerConfig(instanceId) {

}

async function initGatewayConfig(instanceId) {

}

async function initWebAccessConfig(instanceId) {
  //systemsManager.sendCommand({DocumentName: "RemoveGatewayFromRDS", InstanceIds: [PrimaryBrokerInstanceId]})

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

/**
 * Simple wait function to delay whenever needed.
 * @param ms milliseconds to wait
 * @returns {Promise<undefined>}
 */
async function wait(ms) {
  return await new Promise((resolve)=>setTimeout(resolve, ms));
}

module.exports.wait = wait;
module.exports.getDeployment = getDeployment;
module.exports.setDeploymentMember = setDeploymentMember;
module.exports.grabConch = grabConch;
module.exports.releaseConch = releaseConch;