var mongoose = require('mongoose');

var MetricSchema = new mongoose.Schema({
	instance_id: String,
	instance_type: String,
	service_name: String,	
	region: String,
	
	time_stamp: Date,
	unit: String,
	minimum: Number,
	maximum: Number,
	sum: Number,
	average: Number
});

module.exports = MetricSchema;