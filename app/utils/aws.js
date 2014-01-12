var AWS = {
	aws : require('aws-sdk'),
	
	createService : function(akid, sak) {

		this.aws.config.update({
			"accessKeyId" : akid,
			"secretAccessKey" : sak,
			"region" : "ap-northeast-1"
		});
		
		return this.aws;
	},
};

module.exports = AWS;
