"use strict";

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');

const new_oswap_aa = 'OSWAP2243TPPVDCKVKNWDXEHS4YMSEGY';


const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function renounce() {
	const unit = await dag.sendAARequest(new_oswap_aa, { renounce: 1 }, 1);
	if (unit)
		console.error(`Sent renounce request, unit: ${unit}`);
	else
		throw new Error(`Failed to send renounce request`);
}

async function work() {
	await operator.start();
	const my_address = operator.getAddress();
	console.error(`Operator address: ${my_address}`);
	await wait(500);
	await renounce();
	process.exit();
}

work();
