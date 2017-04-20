'use strict';

class S3Deploy {
  constructor(serverless, options) {
    this.serverless  = serverless;
    this.options     = options;
    this.service     = serverless.service;
    this.provider    = this.serverless.getProvider('aws');
    this.providerConfig = this.service.provider;
    this.functionPolicies = {};

    this.commands    = {
      s3deploy: {
        lifecycleEvents: [
          'events'
        ]
      },
    };
    this.hooks = {
      'after:s3deploy:events': this.afterS3DeployFunctions.bind(this)
    };
  }

  afterS3DeployFunctions() {
    let funcObjs = this.service.getAllFunctions().map(name => this.service.getFunction(name));

    //turn functions into the config objects (flattened)
    let lambdaConfigs = funcObjs.map(obj => this.getLambdaFunctionConfigurationsFromFunction(obj))
    .reduce((flattened, c) => flattened = flattened.concat(c), []);

    //collate by bucket
    let bucketNotifications = lambdaConfigs.reduce((buckets, c) => {
      // TODO simplify this
      //find existing array with bucket name
      let bucketLambdaConfigs = buckets.find(existing => existing.Bucket === c.bucket);
      //otherwise create it
      if (!bucketLambdaConfigs) {
        bucketLambdaConfigs = { Bucket: c.bucket, NotificationConfiguration: { LambdaFunctionConfigurations: [] } };
        buckets.push(bucketLambdaConfigs);
      }
      //add config to notification
      bucketLambdaConfigs.NotificationConfiguration.LambdaFunctionConfigurations.push(c.config);
      return buckets;
    }, []);

    //skip empty configs
    if (bucketNotifications.length === 0) {
      return Promise.resolve();
    }

    //find the info plugin
    let info = this.serverless.pluginManager.getPlugins().find(i => i.constructor.name === 'AwsInfo');
    //use it to get deployed functions to check for things to attach to
    return info.getStackInfo().then(() => {
      // TODO make this a separate method
      let results = info.gatheredData.info;

      let permsPromises = [];
      let buckets = [];
      bucketNotifications.forEach((bucket) => {
        //check this buckets notifications and replace the arn with the real one
        bucket.NotificationConfiguration.LambdaFunctionConfigurations.forEach((cfg) => {
          let deployed = results.functions.find((fn) => fn.deployedName.replace(results.service + "-", "") === cfg.LambdaFunctionArn);
          if (!deployed) {
            throw new Error("It looks like the function has not yet beend deployed. You must use 'sls deploy' before doing 'sls s3deploy.");
          }
          //get the full arn!
          let output = info.gatheredData.outputs.find((out) => out.OutputValue.indexOf(deployed.deployedName.replace(results.service + "-", "")) !== -1);
          let arn = output.OutputValue.replace(/:\d$/, ''); //unless using qualifier?
          arn = arn.replace(results.service + "-", "")

          //replace placeholder ARN with final
          cfg.LambdaFunctionArn = arn;
          this.serverless.cli.log(`Attaching ${deployed.deployedName.replace(results.service + "-", "")} to ${bucket.Bucket} ${cfg.Events}...`);

          //attach the bucket permission to the lambda
          let permConfig = {
            Action: "lambda:InvokeFunction",
            FunctionName: deployed.deployedName.replace(results.service + "-", ""),
            Principal: 's3.amazonaws.com',
            StatementId: `${deployed.deployedName.replace(results.service + "-", "")}-${bucket.Bucket}`, // TODO hash the entire cfg? in case multiple
            //Qualifier to point at alias or version
            SourceArn: `arn:aws:s3:::${bucket.Bucket}`
          };
          console.log('perm config: ', permConfig);
          permsPromises.push(this.lambdaPermApi(permConfig));
        });

        //attach the event notification to the bucket
        buckets.push(bucket);
      });

      //run permsPromises before buckets
      return Promise.all(permsPromises)
      .then(() => Promise.all(buckets.map((b) => this.s3EventApi(b))));
    })
    .then(() => this.serverless.cli.log('Done.'));
  }

  getLambdaFunctionConfigurationsFromFunction(functionObj) {
    return functionObj.events
    .filter(event => event.existingS3)
    .map(event => {
      let bucketEvents = event.existingS3.events || event.existingS3.bucketEvents || ['s3:ObjectCreated:*'];
      let eventRules = event.existingS3.rules || event.existingS3.eventRules || [];

      const returnObject = {
        bucket: event.existingS3.bucket,
        config: {
          Id: 'trigger-' + functionObj.name + '-when-' + bucketEvents.join().replace(/[\.\:\*]/g,''), // TODO hash the filter?
          LambdaFunctionArn: functionObj.name,
          Events: bucketEvents
        }
      };

      if (eventRules.length > 0) {
        returnObject.config.Filter = {};
        returnObject.config.Filter.Key = {};
        returnObject.config.Filter.Key.FilterRules = [];
      }

      eventRules.forEach(rule => {
        Object.keys(rule).forEach(key => {
          returnObject.config.Filter.Key.FilterRules.push({
            Name: key,
            Value: rule[key]
          });
        });
      });

      return returnObject;
    })
  }

  s3EventApi(cfg) {
    //this is read/modify/put
    console.log("S3 Event API Config: ", cfg);
    console.log("LambdaFunctionConfigurations: ", cfg.NotificationConfiguration.LambdaFunctionConfigurations);
    return this.provider.request('S3', 'getBucketNotificationConfiguration', { Bucket: cfg.Bucket }, this.providerConfig.stage, this.providerConfig.region)
    .then((bucketConfig) => {
      //find lambda with our ARN or ID, replace it or add a new one
      cfg.NotificationConfiguration.LambdaFunctionConfigurations.forEach((ourcfg) => {
        console.log("our config: ", ourcfg);
        let currentConfigIndex = bucketConfig.LambdaFunctionConfigurations.findIndex((s3cfg) => ourcfg.LambdaFunctionArn === s3cfg.LambdaFunctionArn || ourcfg.Id === s3cfg.Id);
        if (currentConfigIndex !== -1) {
          //just remove it
          bucketConfig.LambdaFunctionConfigurations.splice(currentConfigIndex, 1);
        }
        //push new config
        bucketConfig.LambdaFunctionConfigurations.push(ourcfg);
      });
      debugger;
      console.log("bucket config: ", bucketConfig);
      return { Bucket: cfg.Bucket, NotificationConfiguration: bucketConfig };
    }).then((cfg) => {
      console.log("bucket notification config", cfg);
      return this.provider.request('S3', 'putBucketNotificationConfiguration', cfg, this.providerConfig.stage, this.providerConfig.region);
    });
  }

  lambdaPermApi(cfg) {
    //detect existing config with a read call
    //https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Lambda.html#getPolicy-property
    console.log("Lambda Perm API Being Called");
    var existingPolicyPromise = null;
    if (this.functionPolicies[cfg.FunctionName]) {
      console.log("There is an existing policy promise");
      existingPolicyPromise = Promise.resolve(this.functionPolicies[cfg.FunctionName]);
    } else {
      console.log("have to find the existing policy promise");
      try {
        existingPolicyPromise = this.provider.request('Lambda', 'getPolicy', { FunctionName: cfg.FunctionName }, this.providerConfig.stage, this.providerConfig.region)
        .then((result) => {
          console.log("result: ", result);
          let policy = JSON.parse(result.Policy);
          this.functionPolicies[cfg.FunctionName] = policy;
          return policy;
        }, (error) => {
          console.log("catching the fail: ", error);
          console.log("This is the config we are trying to pass through: ", cfg);
          this.provider.request('Lambda', 'addPermission', cfg, this.providerConfig.stage, this.providerConfig.region);
          return null;
        });
      } catch (error) {
        console.log("caught in the try catch error: ", error);
        this.provider.request('Lambda', 'addPermission', cfg, this.providerConfig.stage, this.providerConfig.region);
        return null
      }

    }
    if (existingPolicyPromise) {
      return existingPolicyPromise.then((policy) => {
        //find our id
        if (policy) {
          console.log("this might be working now?", policy);
          let ourStatement = policy.Statement.find((stmt) => stmt.Sid === cfg.StatementId);
          if (ourStatement) {
            //delete the statement before adding a new one
            console.log("removing permissions: ", ourStatement);
            return this.provider.request('Lambda', 'removePermission', { FunctionName: cfg.FunctionName, StatementId: cfg.StatementId }, this.providerConfig.stage, this.providerConfig.region);
          } else {
            //just resolve
            return Promise.resolve();
          }
        } else {
          return Promise.resolve();
        }

      })
      .then(() => {
        //put the new policy
        console.log("adding new permissions: ", cfg);
        try {
          return this.provider.request('Lambda', 'addPermission', cfg, this.providerConfig.stage, this.providerConfig.region);
        } catch (error) {
          console.log("There was probably already a policy attached to the lambda function: ", error);
          return null
        }

      });
    }

  }

}

module.exports = S3Deploy;
