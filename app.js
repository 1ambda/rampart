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

// timer
var lock_free_time = 300000;
// Every 300 seconds, Rampart are going to poll
var resource_polling_range = 3000;
// Last 60 minutes
var resource_polling_period = 300;
// Metric Unit : 60 seconds

// mongoose
var mongoose = require('mongoose');
mongoose.connect('mongodb://archer:rampart@localhost/test');

// mongoose model for instance polling
var Instance = require('./app/models/instance');
var Lock = require('./app/models/lock');

// mongoose model for resource polling
var CpuUtilization = require('./app/models/cpu_utilization');
var DiskReadBytes = require('./app/models/disk_read_bytes');
var DiskWriteBytes = require('./app/models/disk_write_bytes');
var DiskReadOps = require('./app/models/disk_read_ops');
var DiskWriteOps = require('./app/models/disk_write_ops');
var NetworkIn = require('./app/models/network_in');
var NetworkOut = require('./app/models/network_out');

var MetricModelMap = {
	CPUUtilization : CpuUtilization,
	DiskReadBytes : DiskReadBytes,
	DiskWriteBytes : DiskWriteBytes,
	DiskReadOps : DiskReadOps,
	DiskWriteOps : DiskWriteOps,
	NetworkIn : NetworkIn,
	NetworkOut : NetworkOut
};

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

// for resource polling
// var cwMetricParams = createMetricParams();
var cwMetricArgList = createMetricArgList();
var cws = [];

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
		// EC2s
		// Cloudwatchs

		fillEC2s(serviceObject, ec2s);
		fillCWs(serviceObject, cws);

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
						ec2.describeInstances(null, polling);
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
							seriesCallback();
							console.log(("Rampart > ").info + ("released"));
							setTimeout(done, lock_free_time);

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

function polling(err, data) {
	if (err) {
		console.log(err);
	} else {

		// Instance Polling
		async.map(data.Reservations, function(item, instanceCallback) {

			var ref = item.Instances[0];
			var instance = createInstance(ref);

			instance.save(function(err, data) {
				if (err) {
					return console.log(err);
				}

				// Resource Polling
				async.map(cwMetricArgList, function(item, resourceCallback) {
					var cw = getCwRegion(cws, instance);
					var cwMetricParams = createMetricParams();
					setMetricParamsTime(cwMetricParams);
					cwMetricParams.MetricName = item.metric_name;
					cwMetricParams.Unit = item.unit;
					cwMetricParams.Dimensions[0].Value = instance.instance_id;

					cw.object.getMetricStatistics(cwMetricParams, function(err, docs) {
						if (err) {
							console.log(err);
						} else {
							var sortedStat = sortResourceStat(docs.Datapoints);

							async.map(sortedStat, function(item, statCallback) {
								var resource = createResource(instance, cwMetricParams.MetricName, item);

								resource.save(function(err, data) {
									if (err) {
										console.log('Metric Duplicated [' + cwMetricParams.MetricName + '] ' + ' > ' +  
											resource.instance_id + '(' + resource.service_name + ')' + ' of ' + resource.region);
									}
									
									statCallback();
								});
							}, function(err, results) {
								resourceCallback();
							});
						}

					});

				}, function(err, results) {
					instanceCallback();
				});

			});

		}, function(err, results) {
			regionFinished++;
			section.emit('sectionCompleted');
		});
	}
};

function sortResourceStat(stat) {
	var sortedStat = _.sortBy(stat, function(item) {
		var compared = new Date(item.Timestamp);
		return compared;
	});

	var parsedStat = _.map(sortedStat, function(item) {
		var time = new Date(item.Timestamp);
		item.Timestamp = time;
		return item;
	});

	return parsedStat;
};

function createResource(instance, metric, stat) {

	var resource = new MetricModelMap[metric];

	resource.instance_id = instance.instance_id;
	resource.instance_type = instance.instance_type;
	resource.region = instance.region;
	resource.service_name = instance.service_name;

	resource.time_stamp = stat.Timestamp;
	resource.unit = stat.Unit;
	resource.minimum = stat.Minimum;
	resource.maximum = stat.Maximum;
	resource.sum = stat.Sum;
	resource.average = stat.Average;

	return resource;
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

	// California
	ec2s[1] = new serviceObject.EC2({
		region : 'us-west-1'
	});

	// Oregon
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

var getCwRegion = function(cws, instance) {
	var result = _.where(cws, {
		region : instance.region
	});

	return result[0];
};

function fillCWs(serviceObject, cws) {

	// Virginia
	cws[0] = {
		object : new serviceObject.CloudWatch({
			region : 'us-east-1'
		}),
		region : 'virginia'
	};

	// California
	cws[1] = {
		object : new serviceObject.CloudWatch({
			region : 'us-west-1'
		}),
		region : 'california'
	};

	// Oregon
	cws[2] = {
		object : new serviceObject.CloudWatch({
			region : 'us-west-2'
		}),
		region : 'oregon'
	};

	// Ireland
	cws[3] = {
		object : new serviceObject.CloudWatch({
			region : 'eu-west-1'
		}),
		region : 'ireland'
	};

	// Singapore
	cws[4] = {
		object : new serviceObject.CloudWatch({
			region : 'ap-southeast-1'
		}),
		region : 'singapore'
	};

	// Sydney
	cws[5] = {
		object : new serviceObject.CloudWatch({
			region : 'ap-southeast-2'
		}),
		region : 'sydney'
	};

	// Toyko
	cws[6] = {
		object : new serviceObject.CloudWatch({
			region : 'ap-northeast-1'
		}),
		region : 'tokyo'
	};

	// Sao Paulo
	cws[7] = {
		object : new serviceObject.CloudWatch({
			region : 'sa-east-1'
		}),
		region : 'saopaulo'
	};
};

function setMetricParamsTime(params) {
	var end = new Date();
	var start = new Date(end);
	start.setMinutes(end.getMinutes() - resource_polling_range);
	params.StartTime = start.toISOString();
	params.EndTime = end.toISOString();
};

function createMetricParams() {

	// Metric Name ,Unit, Dimensions.Value, ,StartTme, EndTime
	// These variables should be set
	// before you call getMetricStatics API

	// StartTime, EndTime will be filled by setMetricParams function
	// MetricName, Unit, Dimensions.Value will be filled
	// by second async.map loop in 'action' function

	var params = {};
	params.MetricName = null;
	params.Unit = null;
	;
	params.Namespace = 'AWS/EC2';
	params.Dimensions = [{
		Name : 'InstanceId',
		Value : null
	}];

	params.Period = resource_polling_period;
	params.Statistics = ['Average', 'Minimum', 'Maximum', 'Sum'];

	return params;
};

function createMetricArgList() {
	var args = [{
		metric_name : 'CPUUtilization',
		unit : 'Percent'
	}, {
		metric_name : 'NetworkIn',
		unit : 'Bytes'
	}, {
		metric_name : 'NetworkOut',
		unit : 'Bytes'
	}, {
		metric_name : 'DiskReadOps',
		unit : 'Count'
	}, {
		metric_name : 'DiskWriteOps',
		unit : 'Count'
	}, {
		metric_name : 'DiskReadBytes',
		unit : 'Bytes'
	}, {
		metric_name : 'DiskWriteBytes',
		unit : 'Bytes'
	}];

	return args;
};

var seriesCallback = function(err, results) {

};

var foreverCallback = function() {

};
