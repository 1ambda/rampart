var AWS = require('./app/utils/aws');
var _ = require('underscore');
var fs = require('fs');
var async = require('async');

// mongoose
var mongoose = require('mongoose');
mongoose.connect('mongodb://archer:rampart@localhost/test');

// mongoose model
var Instance = require('./app/models/instance');
var Lock = require('./app/models/lock');

fs.readFile('./config.json', 'utf8', function(err, data) {
	if (err) {
		console.log("fs error : " + err);
	} else {

		var key = JSON.parse(data);
		var serviceObject = AWS.createService(key.accessKeyId, key.secretAccessKey);
		var ec2s = [];

		fillEC2s(serviceObject, ec2s);
		
		var lock = null;

		var worker = function(done) {

			async.series({
				getLock : function(seriesCallback) {
					console.log("State : Locking");

					Lock.remove(function(err) {
						if (err) {
							console.log(err);
						} else {

							lock = new Lock({
								updatedRecords : 0,
								locked : true
							});

							lock.save(function(err) {
								if (err) {
									console.log(err);
								} else {
									seriesCallback();
								}
							});
						}
					});
				},

				descInstances : function(seriesCallback) {
					console.log("State : Working");

					_.each(ec2s, function(ec2) {
						ec2.describeInstances(null, action);
					});

					setTimeout(seriesCallback, 10000);
				},

				releaseLock : function(seriesCallback) {

					Lock.find(function(err, data) {
						if (err) {
							console.log(err);
						} else {
							lock.locked = false;
							lock.save(function(err) {
								if (err) {
									console.log(err);
								} else {
									console.log("State : Releasing");

									seriesCallback();
									setTimeout(done, 10000);
									// Lock-Free Timer
								}
							});
						}
					});
				}
			});
		};

		async.forever(worker, function(err) {
			// Working..
		});
	}
});

function action(err, data) {
	if (err) {
		console.log(err);
	} else {
		_.each(data.Reservations, function(item) {
			var ref = item.Instances[0];
			var instance = createInstance(ref);
			instance.save(function(err, data) {
				if (err) {
					console.log(err);
				}
			});
		});
	}
};

function createInstance(data) {

	var instance = new Instance({
		serivce_name : data.Tags[0].Value,
		instance_id : data.InstanceId,
		instance_type : data.InstanceType,
		instance_state : data.State.Name,
		region : data.Placement.AvailabilityZone,
		public_ip : data.PublicIpAddress,
		private_ip : data.PrivateIpAddress,
		security_group : data.SecurityGroups[0].GroupName
	});

	return instance;
}

function fillEC2s(serviceObject, ec2s) {
	// Virginia
	ec2s[0] = new serviceObject.EC2({
		region : 'us-east-1'
	});
	// Oregon
	ec2s[1] = new serviceObject.EC2({
		region : 'us-west-1'
	});
	// California
	ec2s[2] = new serviceObject.EC2({
		region : 'us-west-2'
	});
	// Ireland
	ec2s[3] = new serviceObject.EC2({
		region : 'eu-west-1'
	});
	// Singapore
	ec2s[4] = new serviceObject.EC2({
		region : 'ap-southeast-1'
	});
	// Sydney
	ec2s[5] = new serviceObject.EC2({
		region : 'ap-southeast-2'
	});
	// Toyko
	ec2s[6] = new serviceObject.EC2({
		region : 'ap-northeast-1'
	});
	// Sao Paulo
	ec2s[7] = new serviceObject.EC2({
		region : 'sa-east-1'
	});

};

var seriesCallback = function(err, results) {

};

var foreverCallback = function() {

};
