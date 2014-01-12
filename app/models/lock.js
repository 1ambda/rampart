var mongoose = require('mongoose');

var LockSchema = new mongoose.Schema({
	updatedRecords: Number,
	locked: Boolean,
	updated: { type: Date, default: Date.now }
});

var Lock = mongoose.model('Lock', LockSchema);

module.exports = Lock;