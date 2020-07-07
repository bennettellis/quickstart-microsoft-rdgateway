"use strict";

const AWS2 = require('aws-sdk');
const ec2 = new AWS.EC2();
const ecs = new AWS.ECS();
const autoscaling = new AWS.AutoScaling();
const sns = new AWS.SNS();
const ddb = new AWS.DynamoDB.DocumentClient();
const systemsManager = new AWS.SSM();

const managementTable = process.env.TABLE_NAME;
const snsTopicArn = process.env.SNS_TOPIC_ARN;

const GATEWAY = "RDS-Gateway";
const BROKER = "RDS-Connection-Broker";
const WEB = "RDS-Web-Access";

const CONFIGURED = "Configured";
const CONFIGURING = "Configuring";
const FAILED = "Failed";
const REMOVED = "Removed";
const REMOVING = "Removing";

module.exports.handler = async(event, context, callback) => {
  try {
    if (!managementTable) throw Error("Value for environment variable TABLE_NAME is missing");
    if (!snsTopicArn) throw Error("Value for SNS Topic to rebroadcast notifications when not ready is missing");
    console.log(event);
    if (event.source === "aws.autoscaling") {
      if (!event.detail || !event.detail.LifecycleActionToken) {
        await handleLifeCycleEvent(event);
      }
    } else if (event.source === "aws.lambda") {
      await handleContinuation(event);
    } else {
      console.log("Not sure what to do with this event!!!! Exiting");
      const message = `Event is not from LifeCycleHook or Lambda. Skipping!`;
      console.log(message);
      callback(null, message);
    }
  } catch (err) {
    console.log(err);
    callback(err);
  }
};

async function handleContinuation(event) {
  let done = false;
  while (!done) {
    const status = await getConfigurationStatus(event.detail.EC2InstanceId);
    switch (status) {
      case CONFIGURED:
        console.log(`All tasks for ${event.detail.EC2InstanceId} completed successfully. Signaling LifeCycleHook ${event.detail.LifecycleHookName} to CONTINUE`);
        // all tasks completed successfully
        await autoscaling.completeLifecycleAction({
          LifecycleHookName: event.detail.LifecycleHookName, AutoScalingGroupName: event.detail.AutoScalingGroupName,
          LifecycleActionToken: event.detail.LifecycleActionToken, LifecycleActionResult: 'CONTINUE'
        }).promise().catch(err => console.log(err));
        await recordInstanceInDDB({InstanceId: event.detail.EC2InstanceId, Status: CONFIGURED);
        done = true;
        break;
      case CONFIGURING:
        console.log(`Awaiting task completion for ${event.detail.EC2InstanceId}. Sleeping for 30 seconds...`);
        await wait(30000); // wait 1/2 minute
        break;
      case FAILED:
        console.log(`Tasks for ${event.detail.EC2InstanceId} failed. Abandoning instance!`);
        await autoscaling.completeLifecycleAction({
          LifecycleHookName: event.detail.LifecycleHookName, AutoScalingGroupName: event.detail.AutoScalingGroupName,
          LifecycleActionToken: event.detail.LifecycleActionToken, LifecycleActionResult: 'ABANDON'
        }).promise().catch(err => console.log(err));
        await recordInstanceInDDB({InstanceId: event.detail.EC2InstanceId, Status: CONFIGURED);
        done = true;


    }
}

async function getConfigurationStatus(InstanceId) {
  // check if this instance is in "ready" state
  const TaskStatuses = await getTaskStatusForInstance(InstanceId);
  if (TaskStatuses.Success === TaskStatuses.Total) {
  } else if (checkTasks === 1) {
    // sleep 5 seconds
    await wait(5000);

    await publishSNSMessage(snsMessage, snsTopicArn);
  }



}

async function handleLifeCycleEvent(event) {
  // received message of scale. Check DB for "Primary Connection Broker" of the deployment
  const autoScalingGroupArn = event.resources[0];
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





async function publishSNSMessage(snsMessage,snsTopicArn) {
  const response = await sns.publish({TopicArn: snsTopicArn, Message: JSON.stringify(snsMessage), Subject: 'reinvoking'}).promise();
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
    FilterExpression : 'Status != :removed',
    ExpressionAttributeValues : {':removed' : "Removed"},
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


function recordInstanceInDDB(InstanceId, Type, Primary, Status) {
  return ddb.put({TableName: managementTable, Item: {InstanceId, Type, Primary, Status}}).promise();
}

function isInstanceRunning(InstanceId) {
  // check instance state. Must be "Pending"
  return ec2.describeInstanceStatus({InstanceIds: [InstanceId]}).promise()
    .then(result => {
      if (result.InstanceStatuses.length > 0) {
        console.log(`Got Status from EC2 Instance ${InstanceId}: ${result.InstanceStatuses[0].InstanceState}`);
        return (/(running|pending)/i.test(result.InstanceStatuses[0].InstanceState));
      }
    })

}

//deployment.GatewayList.splice(idx, 1);

async function removeInstanceFromDeployment(type, instanceId, deployment) {
  if (deployment.PrimaryBroker && deployment.PrimaryBroker.Status === CONFIGURED) {
    switch (type) {
      case GATEWAY:
        const idx = deployment.GatewayList.findIndex(currentValue => currentValue.InstanceId === instanceId);
        if (/remov/i.test(deployment.GatewayList[idx].Status) {

        await recordInstanceInDDB(instanceId, type, false, REMOVING);
        systemsManager.sendCommand({DocumentName: "RemoveGatewayFromRDS", InstanceIds: [PrimaryBrokerInstanceId]})
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
    console.warn(`Attempted to remove instance ${instanceId} of type ${type}, but there is no primary broker. Timing of deployments may be out of whack. Please check.`);
  }

  // check instance state. Must be "Pending"
  const status = await ec2.describeInstanceStatus({InstanceIds: [event.detail.EC2InstanceId]}).promise();
  console.log(`Got Status from EC2 Instance ${event.detail.EC2InstanceId}: ${status}`);
}
