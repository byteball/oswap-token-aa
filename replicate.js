"use strict";
const fs = require('fs');
const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');

const old_oswap_aa = 'OSWAPWKOXZKJPYWATNK47LRDV4UN4K7H';
const old_asset = 'KxyAj3Yk9OFy+cweRFl8yjwYEmeg6scHoRXJsExun98=';
const odex_aa = 'FVRZTCFXIDQ3EYRGQSLE5AMWUQF4PRYJ';

const pools = {
	'O-GBYTE-OSWAP': {
		asset: 'UWkb/dR5Ssezzui9CoIblCVpJ4+9j7x054zpE9fH67o=',
		asset_key: 'a14',
		aa: 'YJ3FVKBJRMZWGJNHYW5E2RRDAFWB6ZC2'
	},
	'O-OSWAP-USDC': {
		asset: '1Rw5RpmwPystzAn7nSuZyAnjr1skwCIRFcQmTAe5ZQc=',
		asset_key: 'a13',
		aa: 'QT4M3USC24Q2MAJLMQBKZT3BADCU25IF',
	},
};

const new_oswap_aa = process.argv[2];

if (!new_oswap_aa) {
	console.error("Usage: node replicate.js <new_oswap_aa_address>");
	process.exit(1);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchDirectHolders(asset) {
	const url = `https://explorer.obyte.org/api/asset/${encodeURIComponent(asset)}/next_page_holders?type=small`;
	const res = await fetch(url);
	const data = await res.json();
	const holders = data.holders || [];
	console.error(`Direct holders: (${holders.length})`, holders);
	return holders;
}

async function fetchOdexHolders() {
	let holders = [];
	const vars = await dag.readAAStateVars(odex_aa, 'balance_');
	for (const var_name in vars) {
		const [, address, asset] = var_name.split('_');
		if (asset !== old_asset) continue;
		const balance = vars[var_name];
		if (balance > 0)
			holders.push({ address, balance });
	}
	console.error(`ODEX holders: (${holders.length})`, holders);
	return holders;
}

async function fetchLpHolders() {
	let lp_holders = {};
	for (const pool_name in pools)
		lp_holders[pool_name] = [];

	// 1. get staked LP token holders from the old OSWAP AA state vars
	const vars = await dag.readAAStateVars(old_oswap_aa);
	for (const var_name in vars) {
		if (!var_name.startsWith('lp_')) continue;
		const [, address, asset_key] = var_name.split('_');
		const lp_balance = vars[var_name].balance;
		for (const pool_name in pools) {
			const pool = pools[pool_name];
			if (pool.asset_key === asset_key) 
				lp_holders[pool_name].push({ address, lp_balance });
		}
	}
	console.error(`staked LP token holders:`, lp_holders);

	// 2. add direct LP token holders
	for (const pool_name in pools) {
		const pool = pools[pool_name];
		const direct_holders = await fetchDirectHolders(pool.asset);
		console.error(`Direct holders of pool ${pool_name}:`, direct_holders);
		for (const { address, balance } of direct_holders) {
			if (await isAA(address)) continue; // skip AAs
			const existingHolder = lp_holders[pool_name].find(h => h.address === address);
			if (existingHolder)
				existingHolder.lp_balance += balance;
			else
				lp_holders[pool_name].push({ address, lp_balance: balance });
		}
	}
	console.error(`all LP token holders:`, lp_holders);

	// 3. calc how much old OSWAP they own through their LP tokens
	let holders = [];
	for (const pool_name in pools) {
		const pool = pools[pool_name];
		const pool_balances = await dag.readAABalances(pool.aa);
		const pool_balance = pool_balances[old_asset];
		if (!isFinite(pool_balance)) throw Error('bad balance for pool ' + pool_name);
		console.error(`Pool ${pool_name} balance: ${pool_balance}`);
		const lp_shares = await dag.readAAStateVar(pool.aa, 'lp_shares');
		const total_shares = lp_shares.issued;
		console.error(`Pool ${pool_name} total shares: ${total_shares}`);
		let total_balance = 0;
		for (const holder of lp_holders[pool_name]) {
			const shares = holder.lp_balance;
			const holder_balance = Math.floor(pool_balance * shares / total_shares);
			total_balance += holder_balance;
			holders.push({ address: holder.address, balance: holder_balance });
		}
		if (Math.abs(total_balance - pool_balance) > lp_holders[pool_name].length) // allow some rounding error
			throw Error(`Discrepancy in pool ${pool_name}: total balance of holders ${total_balance} vs pool balance ${pool_balance}`);
	}
	console.error(`LP holders:`, holders);
	return holders;
}

async function fetchHolders() {
	const direct_holders = await fetchDirectHolders(old_asset);
	const odex_holders = await fetchOdexHolders();
	const lp_holders = await fetchLpHolders();
	const balancesByAddress = new Map();

	for (const holder of [...direct_holders, ...odex_holders, ...lp_holders]) {
		const previousBalance = balancesByAddress.get(holder.address) || 0;
		balancesByAddress.set(holder.address, previousBalance + holder.balance);
	}

	const holders = Array.from(balancesByAddress, ([address, balance]) => ({ address, balance }));
	console.error(`Total holders: (${holders.length})`, holders);
	return holders;
}

async function isAA(address) {
	try {
		const definition = await dag.readAADefinition(address);
		return !!(definition && definition[0] === 'autonomous agent');
	}
	catch (e) {
		return false;
	}
}

async function replicateStateVars() {
	const vars = await dag.readAAStateVars(old_oswap_aa);
	const new_vars = await dag.readAAStateVars(new_oswap_aa);
	fs.writeFileSync('old_vars.json', JSON.stringify(vars, null, 2));
	const var_names = Object.keys(vars).filter(name => name !== 'constants' && !name.startsWith('lp_') && !name.startsWith('pool_asset_balance_'));
	console.error(`Found ${var_names.length} state vars to replicate (excluding 'constants', 'lp_*', and 'pool_asset_balance_*')`, var_names);
//	return;

	let i = 1;
	for (const var_name of var_names) {
		console.error(`Replicating ${i}/${var_names.length}: ${var_name} ...`);
		i++;
		if (new_vars[var_name] !== undefined) {
			console.error(`Variable ${var_name} already exists in the new AA, skipping`);
			continue;
		}
		const unit = await dag.sendAARequest(new_oswap_aa, { var_name }, 1);
		if (unit)
			console.error(`Sent replication request for ${var_name}, unit: ${unit}`);
		else
			throw new Error(`Failed to send replication request for ${var_name}`);
		await wait(500);
	}

	console.error("All state var replication requests sent");
}

async function replicateBalances() {
	console.error("Fetching holders of the old OSWAP asset...");
	const holders = await fetchHolders();
	console.error(`Found ${holders.length} holders`);

	const userOutputs = [];
	for (const holder of holders) {
		const bIsAA = await isAA(holder.address);
		if (bIsAA) {
			console.error(`Skipping AA: ${holder.address}`);
			continue;
		}
		userOutputs.push({ address: holder.address, amount: holder.balance });
	}
	const total_amount = userOutputs.reduce((sum, h) => sum + h.amount, 0);
	console.error(`${userOutputs.length} non-AA holders to replicate, total amount: ${total_amount}`, userOutputs);
//	return;

	const unit = await dag.sendAARequest(new_oswap_aa, { outputs: userOutputs }, 1);
	if (unit)
		console.error(`Sent balance replication request, unit: ${unit}`);
	else
		throw new Error(`Failed to send balance replication request`);

	console.error("All balance replication requests sent");
}

async function work() {
	await operator.start();
	const my_address = operator.getAddress();
	console.error(`Operator address: ${my_address}`);
	await wait(1000);
	await replicateStateVars();
	await replicateBalances();
	process.exit();
}

work();
