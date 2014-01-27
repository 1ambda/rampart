var AWS = require('./app/utils/aws');
var _ = require('underscore');
var fs = require('fs');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var colors = require('colors');
var inquirer = require('inquirer');

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
var lock_free_time = 300 * 1000;
// Every 300 seconds, Rampart are going to poll
var resource_polling_range = 7200;
// Last 7200 minutes
var resource_polling_period = 300;
// Metric Unit : 300 seconds
var second = 1000;
var minute = second * 60;

var startTime = null;
var endTime = null;
var once = false;

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
var Alert = require('./app/models/alert');

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
	alert: 0,
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

		var lock = null;

		var worker = function(done) {

			fillEC2s(serviceObject, ec2s);
			fillCWs(serviceObject, cws);

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

								startTime = lock.polling_end_time;
								endTime = new Date(startTime);
								endTime.setMinutes(endTime.getMinutes() + (resource_polling_range));
								var currentTime = new Date();

								if (endTime > currentTime) {
									endTime = currentTime;
								}

							} else {
								// no Lock
								console.log(("Rampart > ").info + ("locked") + (" [Non-Exist]").help);
								lock = new Lock({
									locked : true
								});
								endTime = new Date();
								startTime = new Date(endTime);
								startTime.setMinutes(endTime.getMinutes() - resource_polling_range);

								lock.polling_end_time = startTime;
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

				descAlerts : function(seriesCallback) {
					async.map(cws, function(cw, regionCallback) {

						cw.object.describeAlarms({}, function(err, docs) {
							if (err) {
								console.log(err);
								console.log('here');
								return alertCallback();
							}
							
							async.map(docs.MetricAlarms, function(item, alertCallback) {
								
								if(item.Dimensions.length >= 2) {
									return alertCallback(); // Billing alert is useless.
								}
								
								var parsedCondition = null;

								switch(item.ComparisonOperator) {
									case "GreaterThanOrEqualToThreshold" :
										parsedCondition = ">=";
										break;
									case "GreaterThanThreshold" :
										parsedCondition = ">";
										break;
									case "LessThanThreshold" :
										parsedCondition = "<";
										break;
									case "LessThanOrEqualToThreshold" :
										parsedCondition = "<=";
										break;
								}
								

								var alert = new Alert({
									action_ok : item.OKActions[0] || 'none',
									action_alarm : item.AlarmActions[0] || 'none',
									action_insufficient : item.InsufficientDataActions[0] || 'none',
									type : (item.Dimensions.length === 0) ? "InstanceId" : item.Dimensions[0].Name,
									object : (item.Dimensions.length === 0) ? "All Instances" : item.Dimensions[0].Value,
									name : item.AlarmName,
									description : item.AlarmDescription || '',
									status : item.StateValue,
									condition : parsedCondition,
									threshold : item.Threshold,
									statistic : item.Statistic,
									metric : item.MetricName,
									period : Number(item.Period) * Number(item.EvaluationPeriods),
									region: cw.region,
									time_stamp: startTime
								});

								alert.save(function(err) {
									if (err) {
										console.log(err);
									}
									
									updatedRecords.alert++;
									return alertCallback();
								});

							}, function(err, results) {
								regionCallback();
							});

						});

					}, function(err, results) {
						seriesCallback();
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
						alert: 0,
					};
					regionNumber = 0;
					regionFinished = 0;
					descSectionDone = null;

					lock.save(function(err) {
						if (err) {
							console.log(err);
						} else {
							seriesCallback();

							var current = new Date();

							console.log(("Rampart > ").info + ("released"));
							console.log('          ' + (startTime.toString()).grey + (' [From]').help);
							console.log('          ' + (endTime.toString()).grey + (' [To]').help);
							console.log('          ' + (current.toString()).grey + (' [Now]').help);
							console.log();

							var diff = (current.getTime() - endTime.getTime());
							if (!once) {
								if ((diff / 1000) > resource_polling_range * 60) {
									lock_free_time = 0;
								} else {
									lock_free_time = resource_polling_range * minute;
								}
							}
							setTimeout(done, lock_free_time);
						}
					});
				}
			});
		};

		// Prompt Logic
		inquirer.prompt({
			type : "list",
			name : "option",
			message : "Rampart Action",
			choices : ["Once", "Continuously"],
			filter : function(val) {
				return val.toLowerCase();
			}
		}, function(polling) {

			var choices = [];

			switch(polling.option) {

				case 'continuously' :
					choices = ['1 Minutes', '5 Minutes', '10 Minutes', '30 Minutes', '60 Minutes'];
					break;
				case 'once' :
					// choices = ['1 Day', '3 Days ', '5 Days', '1 Week', '2 Weeks'];
					choices = ['1 Day', '3 Days', '5 Days'];
					break;
			}

			inquirer.prompt({
				type : "list",
				name : "option",
				message : "Time Range",
				choices : choices,
				filter : function(val) {
					return val.toLowerCase();
				}
			}, function(range) {
				if (polling.option == 'continuously') {

					var range = Number(range.option.split(' ')[0]);

					lock_free_time = range * minute;

					if (range == 1) {
						resource_polling_period = 60;
					}

					resource_polling_range = range;

					async.forever(worker, function(err) {
					});

					// TODO : Timer
					// we need timer to remove '2'. This code wastes time and resources
					// sometime, this code caouse rampart not to collect proper data
					// but i have no time to use timer.

				} else {
					// if once
					var rangeString = range.option.split(' ');

					if (/^Week/i.test(rangeString[1])) {
						var day = 1440;
						var count = rangeString[0] * 7;
						lock_free_time = 1000;
						resource_polling_range = day;

						async.timesSeries(count, function(err, next) {
							worker(next);
						}, function(err, results) {
							process.exit(0);
						});

					} else {
						// day
						once = true;
						var TimeMap = {
							'1 day' : 1440,
							'3 days' : 4320,
							'5 days' : 7200
						};
						var range = TimeMap[range.option];
						lock_free_time = 1000;
						resource_polling_range = range;

						async.timesSeries(1, function(err, next) {
							worker(next);
						}, function(err, results) {
							process.exit(0);
						});
					}
				}

			});
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
										console.log('Metric Duplicated [' + cwMetricParams.MetricName + '] ' + ' > ' + resource.instance_id + '(' + resource.service_name + ')' + ' of ' + resource.region);
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
	// console.log(data.LaunchTime);

	var zone = data.Placement.AvailabilityZone;
	var region = checkRegion(zone);

	updatedRecords.global++;
	updatedRecords[region]++;

	var instance = new Instance({
		service_name : ( data.Tags.length ) ? data.Tags[0].Value : '',
		instance_id : data.InstanceId,
		instance_type : data.InstanceType,
		instance_state : data.State.Name,
		region : region,
		public_ip : (data.PublicIpAddress) ? data.PublicIpAddress : '',
		private_ip : (data.PrivateIpAddress) ? data.PrivateIpAddress : '',
		launch_time : data.LaunchTime,
		security_group : (data.SecurityGroups.length !== 0) ? data.SecurityGroups[0].GroupName : ''
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
	lock.alert = updatedRecords.alert;
	lock.polling_end_time = endTime;
	lock.polling_range = resource_polling_range;

	console.log(("\t  Updated [Global]: " + updatedRecords.global).warn);
	console.log(("\t  Updated [Tokyo]: " + updatedRecords.tokyo).debug);
	console.log(("\t  Updated [Singapore]: " + updatedRecords.singapore).debug);
	console.log(("\t  Updated [Sydney]: " + updatedRecords.sydney).debug);
	console.log(("\t  Updated [Ireland]: " + updatedRecords.ireland).debug);
	console.log(("\t  Updated [Saopaulo]: " + updatedRecords.saopaulo).debug);
	console.log(("\t  Updated [Virginia]: " + updatedRecords.virginia).debug);
	console.log(("\t  Updated [California]: " + updatedRecords.california).debug);
	console.log(("\t  Updated [Oregon]: " + updatedRecords.oregon).debug);
	console.log(("\t  Updated [Alert]: " + updatedRecords.alert).help);
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
	var end = endTime;
	var start = startTime;
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
