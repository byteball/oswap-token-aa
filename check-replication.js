"use strict";

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const _ = require('lodash');

const old_oswap_aa = 'OSWAPWKOXZKJPYWATNK47LRDV4UN4K7H';
const new_oswap_aa = 'OSWAP2243TPPVDCKVKNWDXEHS4YMSEGY';


async function check() {
	const vars = await dag.readAAStateVars(old_oswap_aa);
	const new_vars = await dag.readAAStateVars(new_oswap_aa);
	console.error(Object.keys(vars).length, Object.keys(new_vars).length, new_vars);
	// these vars are intentionally not replicated (see replicate.js/replicateStateVars() and oswap.oscript's replication case)
	for (const name of Object.keys(vars)) {
		if (name === 'constants' || name.startsWith('lp_') || name.startsWith('pool_asset_balance_'))
			delete vars[name];
	}
	delete new_vars.constants;
	console.error(_.isEqual(vars, new_vars));
}

async function work() {
	await operator.start();
	await check();
	process.exit();
}

work();
