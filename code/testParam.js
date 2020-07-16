"use strict";

const idx = require("./index");

const AWS = require("aws-sdk");
const systemsManager = new AWS.SSM();

const GATEWAY = "RDS-Gateway";
const BROKER = "RDS-Connection-Broker";
const WEB = "RDS-Web-Access";

const NEW = "New";
const CONFIGURED = "Configured";
const CONFIGURING = "Configuring";
const REMOVING = "Removing";

const rdsDeploymentName = process.env.RDS_DEPLOYMENT_NAME;

// idx.grabConch()
//   .then(conchToken => {
//     return idx.releaseConch(conchToken);
//   });

systemsManager.deleteParameter({Name: rdsDeploymentName}).promise()
  .catch(err => {
    //ignore;
  })
  .then( () => {
    return systemsManager.deleteParameter({Name: rdsDeploymentName + "-Conch"}).promise()
      .catch(err => {
        // ignore
      });
  })
  .then(() => {
    return idx.wait(100);
  })
  .then(() => {
    return idx.getDeployment();
  })
  .then(deployment1 => {
    console.log(JSON.stringify(deployment1, null, 2));
  })
  .then(deployment => {
    console.log("Attempting to add instances to deployment...");
    return Promise.all([{InstanceId: "i-madeup1", Type: BROKER, Status: NEW, PrimaryBroker: true},
        {InstanceId: "i-madeup2", Type: BROKER, Status: NEW, PrimaryBroker: true},
        {InstanceId: "i-madeup3", Type: GATEWAY, Status: NEW},
        {InstanceId: "i-madeup4", Type: GATEWAY, Status: NEW},
        {InstanceId: "i-madeup5", Type: WEB, Status: NEW},
        {InstanceId: "i-madeup6", Type: WEB, Status: NEW}
      ].map(member => {
        return idx.wait(Math.random() * 1000)
          .then(() => {
            return idx.setDeploymentMember(member)
              .catch(err => {
                if (err.message === "Attempting to add primary broker when we already have one!!!") {
                  return idx.setDeploymentMember(Object.assign(member, {PrimaryBroker: false}));
                }
              });
          });
    }))
      .then(() => {
        return idx.getDeployment();
      })
      .then(deployment1 => {
        console.log(JSON.stringify(deployment1, null, 2));
      });
  });


