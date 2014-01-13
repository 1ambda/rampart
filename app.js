var AWS = require('./app/utils/aws');
var _ = require('underscore');
var fs = require('fs');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var colors = require('colors');

colors.setTheme({
	silly : 'rainbow',
	input : 'grey',
	verbose : 'cyan',
	prompt : 'grey',
	info : 'green',
	data : 'grey',
	help : 'cyan',
	warn : 'yellow',
	debug : 'magenta',
	error : 'red'
});

// mongoose
var mongoose = require('mongoose');
mongoose.connect('mongodb://archer:rampart@localhost/test');

// mongoose model
var Instance = require('./app/models/instance');
var Lock = require('./app/models/lock');

// 'section' means the process of getting information of a instance
var section = new EventEmitter();
var descSectionDone = null;

var regionFinished = 0;
var regionNumber = 0;
var updatedRecords = {
	global : 0,
	tokyo : 0,
	singapore : 0,
	sydney : 0,
	ireland : 0,
	saopaulo : 0,
	virginia : 0,
	california : 0,
	oregon : 0,
};

section.on('sectionCompleted', function(regionRecord) {

	console.log('\t  Region Status : ' + regionFinished + '/' + regionNumber);

	if (regionNumber === regionFinished) {
		descSectionDone();
	}
});

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

					Lock.find(function(err, locks) {

						if (err) {
							console.log(err);
						} else {
							if (locks.length) {
								console.log(("Rampart > ").info + ("locked") + (" [Exist]").help);
								lock = locks[0];
								lock.locked = true;
							} else {
								console.log(("Rampart > ").info + ("locked") + (" [Non-Exist]").help);
								lock = new Lock({
									locked : true
								});
							}

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
					console.log(("Rampart > ").info + ("working"));
					descSectionDone = seriesCallback;

					regionNumber = ec2s.length;
					console.log(('\t  Region Number : ' + regionNumber).grey);

					_.each(ec2s, function(ec2) {
						ec2.describeInstances(null, action);
					});
				},

				releaseLock : function(seriesCallback) {

					makeLock(lock, updatedRecords);

					// Re-initailize lock-related data
					updatedRecords = {
						global : 0,
						tokyo : 0,
						singapore : 0,
						sydney : 0,
						ireland : 0,
						saopaulo : 0,
						virginia : 0,
						california : 0,
						oregon : 0,
					};
					regionNumber = 0;
					regionFinished = 0;
					descSectionDone = null;

					lock.save(function(err) {
						if (err) {
							console.log(err);
						} else {
							console.log(("Rampart > ").info + ("released"));

							seriesCallback();
							// Lock-Free Timer
							setTimeout(done, 120000);

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

		async.map(data.Reservations, function(item, callback) {

			var ref = item.Instances[0];
			var instance = createInstance(ref);

			instance.save(function(err, data) {
				if (err) {
					console.log(err);
				}

				callback();
			});

		}, function(err, results) {
			regionFinished++;
			section.emit('sectionCompleted');
		});
	}
};

function createInstance(data) {

	var zone = data.Placement.AvailabilityZone;
	var region = checkRegion(zone);

	updatedRecords.global++;
	updatedRecords[region]++;

	var instance = new Instance({
		service_name : data.Tags[0].Value,
		instance_id : data.InstanceId,
		instance_type : data.InstanceType,
		instance_state : data.State.Name,
		region : region,
		public_ip : data.PublicIpAddress,
		private_ip : data.PrivateIpAddress,
		security_group : data.SecurityGroups[0].GroupName
	});

	return instance;
}

function makeLock(lock, updatedRecords) {

	lock.locked = false;
	lock.updated = new Date().toISOString();
	lock.global = updatedRecords.global;
	lock.tokyo = updatedRecords.tokyo;
	lock.singapore = updatedRecords.singapore;
	lock.sydney = updatedRecords.sydney;
	lock.ireland = updatedRecords.ireland;
	lock.saopaulo = updatedRecords.saopaulo;
	lock.california = updatedRecords.california;
	lock.virginia = updatedRecords.virginia;
	lock.oregon = updatedRecords.oregon;
	
	console.log(("\t  Updated [Global]: " + updatedRecords.global).warn);
	console.log(("\t  Updated [Tokyo]: " + updatedRecords.tokyo).debug);
	console.log(("\t  Updated [Singapore]: " + updatedRecords.singapore).debug);
	console.log(("\t  Updated [Sydney]: " + updatedRecords.sydney).debug);
	console.log(("\t  Updated [Ireland]: " + updatedRecords.ireland).debug);
	console.log(("\t  Updated [Saopaulo]: " + updatedRecords.saopaulo).debug);
	console.log(("\t  Updated [Virginia]: " + updatedRecords.virginia).debug);
	console.log(("\t  Updated [California]: " + updatedRecords.california).debug);
	console.log(("\t  Updated [Oregon]: " + updatedRecords.oregon).debug);
};

function checkRegion(zone) {

	var region = null;

	if (/^ap-northeast-1/.test(zone)) {
		region = 'tokyo';
	} else if (/^ap-southeast-2/.test(zone)) {
		region = 'sydney';
	} else if (/^ap-southeast-1/.test(zone)) {
		region = 'singapore';
	} else if (/^sa-east-1/.test(zone)) {
		region = 'saopaulo';
	} else if (/^eu-west-1/.test(zone)) {
		region = 'ireland';
	} else if (/^us-west-1/.test(zone)) {
		region = 'california';
	} else if (/^us-west-2/.test(zone)) {
		region = 'oregon';
	} else if (/^us-east-1/.test(zone)) {
		region = 'virginia';
	}

	return region;
};

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
