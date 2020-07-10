"use strict";

const AWS = require('aws-sdk');
const ec2 = new AWS.EC2();
const ecs = new AWS.ECS();
const autoscaling = new AWS.AutoScaling();
const sns = new AWS.SNS();
const ddb = new AWS.DynamoDB.DocumentClient();
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
const FAILED = "Failed"
const CANCELLING = "Cancelling";

const DEFAULT_DELAY = 30000;

/**
 * Main hanlder determines how to handle event and delegates
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
    console.log(event);
    if ((event.detail && event.detail.LifecycleActionToken) && (/(autoscaling|lambda)/i.test(event.source))) {
      if (event.detail.StatusCheck) {
        console.log(`Handling status check event from Lambda...`)
        message = await handleStatusCheck(event);
      } else {
        console.log(`Handling scaling event from autoscaling with LifeCycleHook...`)
        await handleLifeCycleEvent(event);
      }
    } else if ((event.detail && event.detail.WorkspaceId)) {
      await handleWorkspaceEvent(event);
    } else {
      message = `Event is not from AutoScaling LifeCycleHook or Lambda status check. Skipping!`;
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
  if (/LAUNCHING$/i.test(event.detail.LifecycleHookName)) {
    const type = event.detail.LifecycleHookName.replace("-LAUNCHING", "");
    console.log(`Instance is LAUNCHING. Type is ${type}`);
    await addInstanceToDeployment(type, event.detail.EC2InstanceId, deployment);
    console.log(`Added Instance ${event.detail.EC2InstanceId} as ${type} to deployment.`);
  } else if (/TERMINATING/i.test(event.detail.LifecycleHookName)) {
    const type = event.detail.LifecycleHookName.replace("-TERMINATING", "");
    console.log(`Instance is TERMINATING. Type is ${type}`);
    await removeInstanceFromDeployment(type, event.detail.EC2InstanceId, deployment);
    console.log(`Removed Instance ${event.detail.EC2InstanceId} of ${type} from deployment.`);
  } else {
    console.log(`Unknown LifeCycleHook Name. Should end in either LAUNCHING or TERMINATING (LifeCycleHookName: ${event.detail.LifecycleHookName}). Skipping!`);
  }
}

/**
 * Handles a "status check" event from this lambda in order to wait for configuration completions
 * @param event
 * @returns {Promise<void>}
 */
async function handleStatusCheck(event) {
  // check status of all existing commands run against the instance
  const status = await getConfigurationStatus(event.detail.EC2InstanceId);
  // STATUS of configuration commands sent to
  switch (status) {
    case SUCCESS:
      console.log(`Configuration status for ${event.detail.EC2InstanceId}: ${status}. Signaling 'CONTINUE' for LifeCycleHook ${event.detail.LifecycleHookName}.`);
      // Complete the LifeCycle Action (CONTINUE)
      await autoscaling.completeLifecycleAction({
        LifecycleHookName: event.detail.LifecycleHookName, AutoScalingGroupName: event.detail.AutoScalingGroupName,
        LifecycleActionToken: event.detail.LifecycleActionToken, LifecycleActionResult: 'CONTINUE'
      }).promise().catch(err => console.log(err));
      await recordInstanceInDDB({InstanceId: event.detail.EC2InstanceId, Status: CONFIGURED});
      // at this point the instance is fully added or removed from the Deployment
      break;
    case INPROGRESS:
    case PENDING:
    case DELAYED:
      console.log(`Configuration status for ${event.detail.EC2InstanceId}: ${status}. Sleeping for 30 seconds...`);
      await wait(DEFAULT_DELAY); // wait 1/2 minute
      await publishSNSMessage({resources: event.resources, detail: event.detail})
      // at this point the addition or removal of the instance is "in progress" and will be checked by next message
      break;
    case FAILED:
    case CANCELLED:
    case CANCELLING:
    case TIMEDOUT:
      console.log(`Configuration status for ${event.detail.EC2InstanceId}: ${status}. Signaling 'ABANDON' for LifeCycleHook ${event.detail.LifecycleHookName}.`);
      await autoscaling.completeLifecycleAction({
        LifecycleHookName: event.detail.LifecycleHookName, AutoScalingGroupName: event.detail.AutoScalingGroupName,
        LifecycleActionToken: event.detail.LifecycleActionToken, LifecycleActionResult: 'ABANDON'
      }).promise().catch(err => console.log(err));
      await recordInstanceInDDB({InstanceId: event.detail.EC2InstanceId, Status: REMOVING});
      break;
    default:
      console.log(`Result of checking configuration state on instance `)
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
  if (/LAUNCHING$/i.test(event.detail.LifecycleHookName)) {
    const type = event.detail.LifecycleHookName.replace("-LAUNCHING", "");
    console.log(`Instance is LAUNCHING. Type is ${type}`);
    await addInstanceToDeployment(type, event.detail.EC2InstanceId, deployment);
    console.log(`Added Instance ${event.detail.EC2InstanceId} as ${type} to deployment.`);
  } else if (/TERMINATING/i.test(event.detail.LifecycleHookName)) {
    const type = event.detail.LifecycleHookName.replace("-TERMINATING", "");
    console.log(`Instance is TERMINATING. Type is ${type}`);
    await removeInstanceFromDeployment(type, event.detail.EC2InstanceId, deployment);
    console.log(`Removed Instance ${event.detail.EC2InstanceId} of ${type} from deployment.`);
  } else {
    console.log(`Unknown LifeCycleHook Name. Should end in either LAUNCHING or TERMINATING (LifeCycleHookName: ${event.detail.LifecycleHookName}). Skipping!`);
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

async function setContainerInstanceStatusToDraining(ecsClusterName,containerInstanceArn) {
  const response = await ecs.updateContainerInstancesState({cluster: ecsClusterName, containerInstances: [containerInstanceArn], status: 'DRAINING'}).promise();
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
 * Simple wait function to delay whenever needed.
 * @param ms milliseconds to wait
 * @returns {Promise<undefined>}
 */
module.exports.wait = async function(ms) {
  return await new Promise((resolve)=>setTimeout(resolve, ms));
};

/**
 * Get the deployment as marked in the database
 * @returns {Promise<{ PrimaryBroker: {}, BrokerList: [], GatewayList: [], WebAccessList: []}>}
 */
async function getDeployment() {
  const params = {TableName: "",
    AttributesToGet: ["InstanceId", "Type", "Primary", "Status"],
    FilterExpression : 'Status != :removing',
    ExpressionAttributeValues : {':removing' : REMOVING},
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
    switch(member.Type) {
      case BROKER:
        acc.BrokerList.push(member);
        if(member.Primary === true) {
          if(acc.PrimaryBroker) {
            throw Error(`Encountered two Connection Brokers both marked as primary!! (${member.InstanceId}, ${acc.PrimaryBroker.InstanceId})`);
          }
          acc.PrimaryBroker = member;
        }
        break;
      case WEB:
        acc.WebAccessList.puah(member);
        break;
      case GATEWAY:
        acc.GatewayList.push(member);
        break;
      default:
        throw Error(`Encountered unexpected component type ${member.Type} in deployment tracking data. Must be corrected to continue`);
    }
    acc.AllMembersList.push(member);
    return acc;
  }, { PrimaryBroker: null, BrokerList: [], GatewayList: [], WebAccessList: [], AllMembersList: []});
}

async function addInstanceToDeployment(type, instanceId, deployment) {
  switch (type) {
    case GATEWAY:
      if (deployment.PrimaryBroker && deployment.PrimaryBroker.Status === CONFIGURED);
      await recordInstanceInDDB(instanceId, type, false, CONFIGURING);
      break;
    case WEB:
      await recordInstanceInDDB(instanceId, type, false, CONFIGURING);
      break;
    case BROKER:
      await recordInstanceInDDB(instanceId, type, false, CONFIGURING);
      break;
    default:
      throw Error(`Specified type (${type} is not known Remote Desktop Component type`);
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
async function removeInstanceFromDeployment(type, instanceId, deployment) {
  if (deployment.PrimaryBroker && deployment.PrimaryBroker.Status === CONFIGURED) {
    switch (type) {
      case GATEWAY:
        const idx = deployment.GatewayList.findIndex(currentValue => currentValue.InstanceId === instanceId);
        if (!/remov/i.test(deployment.GatewayList[idx].Status) {
          await recordInstanceInDDB(instanceId, type, false, REMOVING);
          systemsManager.sendCommand({DocumentName: "RemoveGatewayFromRDS", InstanceIds: [PrimaryBrokerInstanceId]})
        }
        break;
      case WEB:
          await recordInstanceInDDB(instanceId, type, false, CONFIGURING);
        break;
      case BROKER:
          await recordInstanceInDDB(instanceId, type, false, CONFIGURING);
        break;
      default:
        throw Error(`Specified type (${type} is not known Remote Desktop Component type`);
    }
  } else {
    if (!deployment.PrimaryBroker && type === BROKER) {
      // this is a new PrimaryBroker.
      // We have to avoid race condition of two brokers competing for primacy
      const tempDeployment = await getDeployment();
      if(tempDeployment.PrimaryBroker) {
        recordInstanceInDDB({InstanceId: instanceId, Type: type, Primary: true, Status: NEW})
      }

    }
    console.warn(`Attempted to remove instance ${instanceId} of type ${type}, but there is no primary broker. Timing of deployments may be out of whack. Please check.`);
  }
}


/**
 * Records data for the instance in DynamoDB table
 * @param InstanceData
 * @returns {Promise<PromiseResult<DocumentClient.PutItemOutput, AWSError>>}
 */
function recordInstanceInDDB(InstanceData) {
  // crete or update the item in the table. Only supplied data values will be changed. Existing data will be preserved.
  return ddb.put({TableName: managementTable, Item: InstanceData}).promise();
}


/**
 * Checks the state of the instance to ensure that it is actually in a running state.
 * @param InstanceId
 * @returns {Promise<PromiseResult<EC2.DescribeInstanceStatusResult, AWSError>>}
 */
function isInstanceRunning(InstanceId) {
  // check instance state. Must be "pending..." or "running"
  return ec2.describeInstanceStatus({InstanceIds: [InstanceId]}).promise()
    .then(result => {
      if (result.InstanceStatuses.length > 0) {
        const status = result.InstanceStatuses[0].InstanceState;
        console.log(`Got Status from EC2 Instance ${InstanceId}: ${status}`);
        return (/^(running|pending)/i.test(state));
      }
    });
}


/**
 * Publishes SNS Notification to SNS Queuq
 * @param snsMessage the message to publish
 * @param snsTopicArn the SNS Topic ARN
 * @returns {Promise<PromiseResult<SNS.PublishResponse, AWSError>>}
 */
function publishSNSMessage(snsMessage,snsTopicArn) {
  return sns.publish({TopicArn: snsTopicArn, Message: JSON.stringify(snsMessage), Subject: 'reinvoking'}).promise();
}
