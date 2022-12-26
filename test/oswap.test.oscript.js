// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}


describe('Various trades with the token', function () {
	this.timeout(120000)

	before(async () => {

		this.common_ts = 1657843200

		const lib = fs.readFileSync(path.join(__dirname, '../oswap-lib.oscript'), 'utf8');
		const lib_address = await getAaAddress(lib);
		const initial_sale_pool_base_aa = fs.readFileSync(path.join(__dirname, '../initial-sale-pool.oscript'), 'utf8');
		const initial_sale_pool_base_address = await getAaAddress(initial_sale_pool_base_aa);
		let oswap_aa = fs.readFileSync(path.join(__dirname, '../oswap.oscript'), 'utf8');
		oswap_aa = oswap_aa.replace(/\$lib_aa = '\w{32}'/, `$lib_aa = '${lib_address}'`)
		oswap_aa = oswap_aa.replace(/\$initial_sale_pool_base_aa = '\w{32}'/, `$initial_sale_pool_base_aa = '${initial_sale_pool_base_address}'`)

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ pool1: {} })
			.with.asset({ pool2: {} })
			.with.agent({ oswap_lib: path.join(__dirname, '../oswap-lib.oscript') })
			.with.agent({ sale_pool_base: path.join(__dirname, '../initial-sale-pool.oscript') })
			.with.agent({ deposit: path.join(__dirname, 'deposit.oscript') })
			.with.wallet({ oracle: {base: 1e9} })
			.with.wallet({ alice: {base: 1000e9, pool1: 1000e9, pool2: 10000e9} })
			.with.wallet({ bob: {base: 1000e9, pool1: 1000e9, pool2: 10000e9} })
			.with.wallet({ charlie: {base: 1000e9, pool1: 1000e9, pool2: 10000e9} })
		//	.with.explorer()
			.run()
		
		console.log('--- assets\n', this.network.asset)
		this.pool1 = this.network.asset.pool1
		this.pool2 = this.network.asset.pool2

		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.charlie = this.network.wallet.charlie
		this.charlieAddress = await this.charlie.getAddress()

		this.deposit_aa = this.network.agent.deposit

		oswap_aa = oswap_aa.replace('ORACLEADDRESS', this.oracleAddress)
		const { address: oswap_aa_address, error } = await this.alice.deployAgent(oswap_aa)
		expect(error).to.be.null
		this.oswap_aa = oswap_aa_address
		console.log('--- agents\n', this.network.agent)

		this.reserve_asset = 'base'
		this.bounce_fees = this.reserve_asset !== 'base' && { base: [{ address: this.oswap_aa, amount: 1e4 }] }
		this.network_fee_on_top = this.reserve_asset === 'base' ? 1000 : 0

		this.executeGetter = async (aa, getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress: aa,
				getter,
				args
			})
			if (error)
				console.log(error)
			expect(error).to.be.null
			return result
		}

		this.timetravel = async (shift = '1d') => {
			const { error, timestamp } = await this.network.timetravel({ shift })
			expect(error).to.be.null
		}

		this.get_price = async (asset_label, bAfterInterest = true) => {
			return await this.executeGetter(this.oswap_aa, 'get_price', [asset_label, 0, 0, bAfterInterest])
		}

		this.get_exchange_result = async (tokens, delta_r) => {
			return await this.executeGetter(this.oswap_aa, 'get_exchange_result', [tokens, delta_r])
		}

		this.get_presale_prices = async () => {
			return await this.executeGetter(this.initial_sale_pool_address, 'get_prices')
		}

		this.get_staking_reward = async (user_address) => {
			return await this.executeGetter(this.oswap_aa, 'get_staking_reward', [user_address])
		}

		this.get_lp_reward = async (user_address, pool_asset, deposit_aa) => {
			return await this.executeGetter(this.oswap_aa, 'get_lp_reward', [user_address, pool_asset, deposit_aa])
		}

		this.checkCurve = () => {
			const { reserve, supply, s0, coef } = this.state
			const r = coef * s0 * supply / (s0 - supply)
			expect(r).to.be.closeTo(reserve, 1)
		}

		this.checkVotes = (vars) => {
			expect(vars.group_vps.total).to.eq(vars.state.total_normalized_vp);
			let users = [];
			let grand_total = 0;
			let all_vps = {};
			for (let v in vars) {
				if (v.startsWith('user_')) {
					const user = v.substr(5);
					if (user.length === 32)
						users.push(user);
				}
				if (v.startsWith('pool_vps_g')) {
					const group_num = v.substr(10);
					const pool_vps = vars[v];
					let total = 0;
					for (let key in pool_vps) {
						if (key !== 'total' && pool_vps[key]) {
							total += pool_vps[key];
							all_vps[key] = pool_vps[key];
						}
					}
					expect(total).to.closeTo(pool_vps.total, 1.5);
					expect(total).to.closeTo(vars.group_vps['g' + group_num] || 0, 1.5);
					grand_total += total;
				}
			}
			expect(grand_total).to.closeTo(vars.state.total_normalized_vp, 1);
		
			let total_normalized_vp = 0;
			let all_users_vps = {};
			for (let user of users) {
				const { normalized_vp } = vars['user_' + user];
				total_normalized_vp += normalized_vp;
				let total_votes = 0;
				const votes = vars['votes_' + user];
				for (let key in votes) {
					total_votes += votes[key];
					if (!all_users_vps[key])
						all_users_vps[key] = 0;
					all_users_vps[key] += votes[key];
				}
				expect(total_votes).to.closeTo(normalized_vp, 0.8);
			}
			expect(total_normalized_vp).to.closeTo(vars.state.total_normalized_vp, 0.9)
			expect(Object.keys(all_vps).length).to.eq(Object.keys(all_users_vps).length)
			for (let key in all_vps)
				expect(all_vps[key]).to.closeTo(all_users_vps[key], 0.8);
		}
	})


	it('Post data feed', async () => {
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					TVL: 0.5e6,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload).to.deep.equalInAnyOrder({
			TVL: 0.5e6,
		})
		await this.network.witnessUntilStable(unit)
	})
	
	it('Bob defines the token', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null
		
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				define: 1
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.asset = response.response.responseVars.asset
		this.initial_sale_pool_address = response.response.responseVars.initial_sale_pool_address
	})

	it('Bob whitelists pool1', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_whitelist: 1,
				pool_asset: this.pool1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.message).to.be.eq("whitelisted")
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars.last_asset_num).to.be.eq(1)
		expect(vars.last_group_num).to.be.eq(1)
		expect(vars['pool_vps_g1']).to.be.deep.eq({ total: 0, 'a1': 0 })
		expect(vars['pool_' + this.pool1]).to.be.deep.eq({ asset_key: 'a1', group_key: 'g1', last_lp_emissions: 0, received_emissions: 0 })

	})

	it('Bob tries to whitelist pool2', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_whitelist: 1,
				pool_asset: this.pool2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.eq("only one asset can be added without voting")
		expect(response.bounced).to.be.true
	})



	it('Alice contributes to the initial pool', async () => {
		const amount = 100e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.initial_sale_pool_address, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.added).to.be.eq(amount)

		const { vars } = await this.alice.readAAStateVars(this.initial_sale_pool_address)
		expect(vars['user_' + this.aliceAddress]).to.eq(amount)
		expect(vars.total).to.eq(amount)

		const { final_price, avg_price } = await this.get_presale_prices()
		console.log({ final_price, avg_price })
	})

	it('Bob contributes to the initial pool', async () => {
		const amount = 100e9
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.initial_sale_pool_address, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.added).to.be.eq(amount)

		const { vars } = await this.bob.readAAStateVars(this.initial_sale_pool_address)
		expect(vars['user_' + this.bobAddress]).to.eq(amount)
		expect(vars.total).to.eq(200e9)

		const { final_price, avg_price } = await this.get_presale_prices()
		console.log({ final_price, avg_price })
	})

	it('Bob withdraws half', async () => {
		const amount = 50e9
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				withdraw: 1,
				amount: amount,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.withdrawn).to.be.eq(amount)

		const { vars } = await this.bob.readAAStateVars(this.initial_sale_pool_address)
		expect(vars['user_' + this.bobAddress]).to.eq(50e9)
		expect(vars.total).to.eq(150e9)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: amount,
			},
		])

		const { final_price, avg_price } = await this.get_presale_prices()
		console.log({ final_price, avg_price })

	})

	it('Bob triggers the initial pool to buy too early', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				buy: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.eq("too early")
		expect(response.bounced).to.be.true
	})

	

	it('Bob triggers the initial pool to buy', async () => {
		await this.network.timetravel({ to: '2023-07-01' })
		
		const { final_price, avg_price } = await this.get_presale_prices()
		console.log({ final_price, avg_price })

		const total = 150e9
		const tokens = Math.floor(total / avg_price)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				buy: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.eq("bought")

		const { vars } = await this.bob.readAAStateVars(this.initial_sale_pool_address)
		expect(vars.tokens).to.eq(tokens)
		this.avg_price = total / tokens

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.oswap_aa,
				amount: total + this.network_fee_on_top,
			},
		])
	})

	it('Bob triggers the initial pool to buy again', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				buy: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.eq("already bought")
		expect(response.bounced).to.be.true
	})

	it('Bob stakes the tokens from the initial sale', async () => {	
		const amount = Math.floor(50e9 / this.avg_price)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				stake: 1,
				group_key: 'g1',
				percentages: {a1: 100},
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.sent).to.be.eq(amount)

		const { vars: pool_vars } = await this.bob.readAAStateVars(this.initial_sale_pool_address)
		expect(pool_vars['user_' + this.bobAddress]).to.be.undefined

		const { vars: oswap_vars } = await this.bob.readAAStateVars(this.oswap_aa)
		expect(oswap_vars['user_' + this.bobAddress]).to.be.deepCloseTo({
			balance: amount,
			reward: 0,
			normalized_vp: amount * 4 ** ((response.timestamp - this.common_ts)/360/24/3600),
			last_stakers_emissions: 0,
			expiry_ts: response.timestamp + 4 * 360 * 24 * 3600,
		}, 0.01);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.oswap_aa,
				amount: amount,
			},
		])
		this.bob_vp = oswap_vars['user_' + this.bobAddress].normalized_vp

		this.checkVotes(oswap_vars)
	})

	it('Bob tries to stake the tokens from the initial sale again', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				stake: 1,
				group_key: 'g1',
				percentages: {a1: 100},
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.eq("you have no balance")
		expect(response.bounced).to.be.true
	})

	it('Alice stakes the tokens from the initial sale', async () => {	
		const amount = Math.floor(100e9 / this.avg_price)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.initial_sale_pool_address,
			amount: 10000,
			data: {
				stake: 1,
				group_key: 'g1',
				percentages: {a1: 100},
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.sent).to.be.eq(amount)

		const { vars: pool_vars } = await this.alice.readAAStateVars(this.initial_sale_pool_address)
		expect(pool_vars['user_' + this.aliceAddress]).to.be.undefined

		const { vars: oswap_vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(oswap_vars['user_' + this.aliceAddress]).to.be.deepCloseTo({
			balance: amount,
			reward: 0,
			normalized_vp: amount * 4 ** ((response.timestamp - this.common_ts)/360/24/3600),
			last_stakers_emissions: 0,
			expiry_ts: response.timestamp + 4 * 360 * 24 * 3600,
		}, 0.01);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.oswap_aa,
				amount: amount,
			},
		])

		this.checkVotes(oswap_vars)
	})


	it('Alice buys tokens', async () => {
		const amount = 100e9
		const { new_price, swap_fee, arb_profit_tax, total_fee, coef_multiplier, payout, delta_s, delta_reserve } = await this.get_exchange_result(0, amount);
		expect(payout).to.be.false
		expect(delta_reserve).to.be.gt(0)

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.oswap_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		expect(response.response.responseVars.price).to.eq(new_price)
		expect(response.response.responseVars.swap_fee).to.eq(swap_fee)
		expect(response.response.responseVars.arb_profit_tax).to.eq(arb_profit_tax)
		expect(response.response.responseVars.total_fee).to.eq(total_fee)
		expect(response.response.responseVars.coef_multiplier).to.eq(coef_multiplier)
		expect(response.response.responseVars['fee%']).to.eq((+(total_fee / amount * 100).toFixed(4)) + '%')

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: Math.floor(delta_s),
			},
		])
		this.new_issued_shares = unitObj.messages.find(m => m.app === 'payment' && m.payload.asset === this.asset).payload.outputs.find(o => o.address === this.aliceAddress).amount

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})



	it('Alice sells tokens', async () => {
		const amount = Math.floor(this.new_issued_shares/3)
		const { new_price, swap_fee, arb_profit_tax, total_fee, coef_multiplier, payout, delta_s, delta_reserve } = await this.get_exchange_result(amount, 0);
		expect(delta_s).to.be.eq(-amount)
		expect(delta_reserve).to.be.lt(0)

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.oswap_aa, amount: amount }],
				base: [{ address: this.oswap_aa, amount: 1e4 }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		expect(response.response.responseVars.price).to.eq(new_price)
		expect(response.response.responseVars.swap_fee).to.eq(swap_fee)
		expect(response.response.responseVars.arb_profit_tax).to.eq(arb_profit_tax)
		expect(response.response.responseVars.total_fee).to.eq(total_fee)
		expect(response.response.responseVars.coef_multiplier).to.eq(coef_multiplier)
		expect(response.response.responseVars['fee%']).to.eq((+(total_fee / (-delta_reserve + total_fee) * 100).toFixed(4)) + '%')

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: payout,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice stakes tokens', async () => {
		const amount = Math.floor(this.new_issued_shares/3)
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.oswap_aa, amount: amount }],
				base: [{ address: this.oswap_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					stake: 1,
					term: 4 * 360,
					group_key: 'g1',
					percentages: {a1: 100},
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state
		this.pool_vps_g1 = vars.pool_vps_g1

		this.checkCurve()
		this.checkVotes(vars)
	})


	it('Alice whitelists pool2', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_whitelist: 1,
				pool_asset: this.pool2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.message).to.be.eq("whitelisted")
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars.last_asset_num).to.be.eq(2)
		expect(vars.last_group_num).to.be.eq(1)
		expect(vars['pool_vps_g1']).to.be.deep.eq({ total: this.pool_vps_g1.a1, a1: this.pool_vps_g1.a1, a2: 0 })
		expect(vars['pool_' + this.pool2]).to.be.deep.eq({ asset_key: 'a2', group_key: 'g1', last_lp_emissions: 0, received_emissions: 0 })
		this.state = vars.state
		this.alice_vp = vars['user_' + this.aliceAddress].normalized_vp

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice moves a part of her VP to pool2', async () => {
		const vp = this.alice_vp
		console.log({vp})
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_shares: 1,
				group_key1: 'g1',
				changes: { a1: -0.3 * vp, a2: 0.3 * vp },
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		this.state = vars.state
		this.pool_vps_g1 = vars.pool_vps_g1

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice changes swap fee', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_value: 1,
				name: 'swap_fee',
				value: 0.005
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.new_leader).to.be.eq(0.005)
		expect(response.response.responseVars.committed).to.be.eq(0.005)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars['value_votes_swap_fee_0.005']).to.be.eq(this.alice_vp)
		expect(vars['user_value_votes_' + this.aliceAddress + '_swap_fee']).to.be.deep.eq({ value: 0.005, vp: this.alice_vp })
		expect(vars['swap_fee']).to.be.eq(0.005)
		expect(vars['leader_swap_fee']).to.be.deep.eq({ value: 0.005, flip_ts: response.timestamp })

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Alice changes swap fee again', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_value: 1,
				name: 'swap_fee',
				value: 0.006
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.new_leader).to.be.eq(0.006)
		expect(response.response.responseVars.committed).to.be.eq(0.006)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars['value_votes_swap_fee_0.005']).to.be.eq(0)
		expect(vars['value_votes_swap_fee_0.006']).to.be.eq(this.alice_vp)
		expect(vars['user_value_votes_' + this.aliceAddress + '_swap_fee']).to.be.deep.eq({ value: 0.006, vp: this.alice_vp })
		expect(vars['swap_fee']).to.be.eq(0.006)
		expect(vars['leader_swap_fee']).to.be.deep.eq({ value: 0.006, flip_ts: response.timestamp })

		this.checkCurve()
		this.checkVotes(vars)
	})
	

	it('Bob posts a grant request', async () => {
		this.grant_amount = 10e9
		const pledge = "I'm going to do this and that. For my work, I want to be paid " + this.grant_amount + " bytes"

		const { unit, error } = await this.bob.sendMulti({
			messages: [{
				app: 'text',
				payload: pledge
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: unit })
		const textMessage = unitObj.messages.find(m => m.app === 'text')
		expect(textMessage.payload).to.be.equal(pledge)
		await this.network.witnessUntilStable(unit)

		this.grant_request_unit = unit
	})
	
	it('Alice creates a proposal', async () => {
		this.proposal_num = 1
		const expiry = '2030-07-01'

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				add_proposal: 1,
				type: 'grant',
				recipient: this.bobAddress,
				amount: this.grant_amount,
				expiry: expiry,
				unit: this.grant_request_unit
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['count_proposals']).to.be.equal(this.proposal_num)
		expect(vars['proposal_' + this.proposal_num]).to.be.deep.eq({
			recipient: this.bobAddress,
			amount: this.grant_amount,
			unit: this.grant_request_unit,
			expiry,
		})

	})

	it('Alice votes for the proposal', async () => {
		const name = 'proposal'
		const full_name = name + this.proposal_num

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_value: 1,
				name: name,
				num: this.proposal_num,
				value: 'yes'
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['value_votes_' + full_name + '_yes']).to.be.equal(this.alice_vp)
		expect(vars['user_value_votes_' + this.aliceAddress + '_' + full_name]).to.deep.equal({ value: 'yes', vp: this.alice_vp })
		expect(vars['leader_' + full_name]).to.deep.equal({ value: 'yes', flip_ts: response.timestamp })

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: this.grant_amount,
			},
		])

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice votes for the proposal again and nothing changes', async () => {
		const name = 'proposal'

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_value: 1,
				name: name,
				num: this.proposal_num,
				value: 'yes'
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.eq("the proposal has already been decided upon")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

		this.checkCurve()
	})


	it('Alice claims reward', async () => {
		await this.timetravel('180d')

		const reward = Math.floor(await this.get_staking_reward(this.aliceAddress))

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw_staking_reward: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: reward,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})


	it('Bob deposits pool2 tokens to deposit AA', async () => {
		const amount = 40e9
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.pool2]: [{ address: this.deposit_aa, amount: amount }],
				base: [{ address: this.deposit_aa, amount: 1e4 }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.added).to.be.eq(amount)
	})

	it("Alice whitelists 28 more assets to deplete the group1's capacity", async () => {
		let assets = [];
		for (let i = 3; i <= 30; i++){
			const { unit, error } = await this.alice.createAsset({
				is_private: false,
				is_transferrable: true,
				auto_destroy: false,
				issued_by_definer_only: true,
				cosigned_by_definer: false,
				spender_attested: false,
				fixed_denominations: false,
			})
		//	console.log({ unit, error })
			expect(error).to.be.null
			assets.push(unit)
		}
		let num = 2
		for (let asset of assets) {
			num++;
			const { unit, error } = await this.alice.triggerAaWithData({
				toAddress: this.oswap_aa,
				amount: 10000,
				data: {
					vote_whitelist: 1,
					pool_asset: asset,
				},
			})
			expect(error).to.be.null
			expect(unit).to.be.validUnit

			const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		//	console.log(num, response.response.error)
			expect(response.response.error).to.be.undefined
			expect(response.bounced).to.be.false
			expect(response.response.responseVars.message).to.be.eq("whitelisted")

			const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
			expect(vars.last_asset_num).to.be.eq(num)
			expect(vars.last_group_num).to.be.eq(1)
			expect(vars['pool_' + asset]).to.be.deep.eq({ asset_key: 'a' + num, group_key: 'g1', last_lp_emissions: this.state.lp_emissions, received_emissions: 0 })
		}

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars.last_asset_num).to.be.eq(30)
		expect(vars.last_group_num).to.be.eq(1)

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice whitelists pool2-deposit-aa', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_whitelist: 1,
				pool_asset: this.pool2,
				deposit_aa: this.deposit_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.message).to.be.eq("whitelisted")
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars.last_asset_num).to.be.eq(31)
		expect(vars.last_group_num).to.be.eq(2)
		let g1_vps = { total: this.alice_vp + this.bob_vp, a1: this.alice_vp * 0.7 + this.bob_vp, a2: this.alice_vp * 0.3 }
		for (let i = 3; i <= 30; i++)
			g1_vps['a' + i] = 0;
		expect(vars['pool_vps_g1']).to.be.deepCloseTo(g1_vps, 0.01)
		expect(vars['pool_vps_g2']).to.be.deep.eq({ total: 0, a31: 0 })
		expect(vars['pool_' + this.pool2 + '_' + this.deposit_aa]).to.be.deep.eq({ asset_key: 'a31', group_key: 'g2', last_lp_emissions: this.state.lp_emissions, received_emissions: 0 })
		this.state = vars.state
		this.alice_vp = vars['user_' + this.aliceAddress].normalized_vp
		this.pool31_initial_lp_emissions = this.state.lp_emissions

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice moves a part of her VP to pool2-deposit-aa', async () => {
		const vp = this.alice_vp
		console.log({vp})
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_shares: 1,
				group_key1: 'g1',
				group_key2: 'g2',
				changes: { a1: -0.1 * vp, a2: -0.1 * vp, a31: 0.2 * vp },
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})


	it('Alice stakes additional tokens', async () => {
		const amount = Math.floor(this.new_issued_shares/3)
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.asset]: [{ address: this.oswap_aa, amount: amount }],
				base: [{ address: this.oswap_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					stake: 1,
					term: 4 * 360,
					group_key: 'g2',
					percentages: { a31: 100 },
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state
		this.alice_vp = vars['user_' + this.aliceAddress].normalized_vp
		this.pool_vps_g1 = vars.pool_vps_g1
		this.pool_vps_g2 = vars.pool_vps_g2

		this.checkCurve()
		this.checkVotes(vars)
	})


	it('Bob deposits pool1 tokens', async () => {
		const amount = 10e9
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.pool1]: [{ address: this.oswap_aa, amount: amount }],
				base: [{ address: this.oswap_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Bob deposits pool2 tokens', async () => {
		const amount = 20e9
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.pool2]: [{ address: this.oswap_aa, amount: amount }],
				base: [{ address: this.oswap_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state
		this.initial_pool2_state = vars['pool_' + this.pool2]

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Alice deposits pool2 tokens too', async () => {
		await this.timetravel('180d')
		const amount = 20e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.pool2]: [{ address: this.oswap_aa, amount: amount }],
				base: [{ address: this.oswap_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					deposit: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state
		this.pool2_state = vars['pool_' + this.pool2]

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Alice blacklists pool2', async () => {
		await this.timetravel('180d')

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_blacklist: 1,
				pool_asset: this.pool2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.message).to.be.eq("blacklisted")
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars.last_asset_num).to.be.eq(31)
		expect(vars.last_group_num).to.be.eq(2)
		let g1_vps = { total: this.pool_vps_g1.a1 + this.pool_vps_g1.a2, a1: this.pool_vps_g1.a1, a2: this.pool_vps_g1.a2 }
		for (let i = 3; i <= 30; i++)
			g1_vps['a' + i] = 0;
		expect(vars['pool_vps_g1']).to.be.deepCloseTo(g1_vps, 0.001)
		expect(vars['pool_vps_g2']).to.be.deepCloseTo({ total: this.pool_vps_g2.a31, a31: this.pool_vps_g2.a31 }, 0.001);
		expect(vars['pool_' + this.pool2]).to.be.deep.eq({ asset_key: 'a2', group_key: 'g1', last_lp_emissions: this.state.lp_emissions, received_emissions: this.pool2_state.received_emissions, blacklisted: true })
		this.state = vars.state
		this.alice_vp = vars['user_' + this.aliceAddress].normalized_vp

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Bob harvests LP rewards in the blacklisted pool2', async () => {
		await this.timetravel('180d')

		const reward = await this.get_lp_reward(this.bobAddress, this.pool2)
		expect(reward).to.closeTo((this.pool2_state.received_emissions - this.initial_pool2_state.received_emissions) / 2, 0.0001)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw_lp_reward: 1,
				pool_asset: this.pool2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: Math.floor(reward),
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['lp_' + this.bobAddress + '_a2'].reward).to.eq(0)
		this.state = vars.state
		this.pool2_state = vars['pool_' + this.pool2]

		this.checkCurve()
		this.checkVotes(vars)
	})
	

	it('Alice whitelists pool2 again', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_whitelist: 1,
				pool_asset: this.pool2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.message).to.be.eq("re-whitelisted")
	//	await this.network.witnessUntilStable(response.response_unit)

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars.last_asset_num).to.be.eq(31)
		expect(vars.last_group_num).to.be.eq(2)
		let g1_vps = { total: this.pool_vps_g1.a1 + this.pool_vps_g1.a2, a1: this.pool_vps_g1.a1, a2: this.pool_vps_g1.a2 }
		for (let i = 3; i <= 30; i++)
			g1_vps['a' + i] = 0;
		expect(vars['pool_vps_g1']).to.be.deepCloseTo(g1_vps, 0.001)
		expect(vars['pool_vps_g2']).to.be.deepCloseTo({ total: this.pool_vps_g2.a31, a31: this.pool_vps_g2.a31 }, 0.001);
		expect(vars['pool_' + this.pool2]).to.be.deep.eq({ asset_key: 'a2', group_key: 'g1', last_lp_emissions: this.state.lp_emissions, received_emissions: this.pool2_state.received_emissions, blacklisted: false })
		this.state = vars.state
		this.alice_vp = vars['user_' + this.aliceAddress].normalized_vp
		this.pool2_state = vars['pool_' + this.pool2]
		this.pool31_state = vars['pool_' + this.pool2 + '_' + this.deposit_aa]
		expect(this.pool31_state.last_lp_emissions).to.eq(this.pool31_initial_lp_emissions)

		this.checkCurve()
		this.checkVotes(vars)
	})


	it('Bob harvests LP rewards in the newly whitelisted pool2', async () => {
		await this.timetravel('180d')

		const total_emissions = 1 / 2 * 0.1 * this.state.supply // half-a-year * inflation rate
		const lp_emissions = 0.5 * total_emissions
		const pool2_emissions = this.pool_vps_g1.a2 / (this.pool_vps_g1.a1 + this.pool_vps_g1.a2 + this.pool_vps_g2.a31) * lp_emissions
		const reward = await this.get_lp_reward(this.bobAddress, this.pool2)
		expect(reward).to.closeTo(pool2_emissions / 2, 0.0001)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw_lp_reward: 1,
				pool_asset: this.pool2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: Math.floor(reward),
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['lp_' + this.bobAddress + '_a2'].reward).to.eq(0)
		this.state = vars.state
		this.pool2_state = vars['pool_' + this.pool2]

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Bob harvests LP rewards to pool2-deposit-aa', async () => {
		await this.timetravel('180d')
		const total_emissions = 1 / 2 * 0.1 * this.state.supply // half-a-year * inflation rate
		const lp_emissions = 0.5 * total_emissions
		const pool31_emissions = this.pool_vps_g2.a31 / (this.pool_vps_g1.a1 + this.pool_vps_g1.a2 + this.pool_vps_g2.a31) * (this.state.lp_emissions + lp_emissions - this.pool31_initial_lp_emissions)
		const reward = await this.get_lp_reward(this.bobAddress, this.pool2, this.deposit_aa)
		expect(reward).to.closeTo(pool31_emissions, 0.0001)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw_lp_reward: 1,
				pool_asset: this.pool2,
				deposit_aa: this.deposit_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.deposit_aa,
				amount: Math.floor(reward),
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['lp_' + this.bobAddress + '_a31']).to.be.undefined
		expect(vars['lp_' + this.deposit_aa + '_a31'].reward).to.eq(0)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})
	

	it('Bob harvests LP rewards in pool1', async () => {
		await this.timetravel('180d')

		const reward = Math.floor(await this.get_lp_reward(this.bobAddress, this.pool1))

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw_lp_reward: 1,
				pool_asset: this.pool1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: reward,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['lp_' + this.bobAddress + '_a1'].reward).to.eq(0)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Charlie harvests LP rewards for Bob in pool1', async () => {
		await this.timetravel('180d')

		const reward = await this.get_lp_reward(this.bobAddress, this.pool1)

		const { unit, error } = await this.charlie.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw_lp_reward: 1,
				pool_asset: this.pool1,
				for: this.bobAddress
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.charlie, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.charlie.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['lp_' + this.bobAddress + '_a1'].reward).to.eq(reward)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Bob withdraws LP tokens and harvests LP rewards in pool1', async () => {
		await this.timetravel('180d')

		const reward = Math.floor(await this.get_lp_reward(this.bobAddress, this.pool1))

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				withdraw: 1,
				pool_asset: this.pool1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: reward,
			},
			{
				asset: this.pool1,
				address: this.bobAddress,
				amount: 10e9,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['lp_' + this.bobAddress + '_a1']).to.undefined
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})
	
	it('Alice capitalizes her reward and extends the lock', async () => {
		await this.timetravel('180d')

		const { vars: initial_vars } = await this.alice.readAAStateVars(this.oswap_aa)
		const initial_balance = initial_vars['user_' + this.aliceAddress].balance
		const reward = Math.floor(await this.get_staking_reward(this.aliceAddress))

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				stake: 1,
				stake_reward: 1,
				term: 4 * 360,
				group_key: 'g1',
				percentages: {a1: 100},
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		expect(vars['user_' + this.aliceAddress].balance).to.be.eq(initial_balance + reward)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice tries to withdraw her stake too early', async () => {		
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				unstake: 1,
				group_key: 'g1',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.bounced).to.be.true
		expect(response.response.error).to.include("you can unstake only after ")
	})

	it('Alice tries to withdraw her stake without moving all the votes to a single group', async () => {
		await this.timetravel((4 * 360) + 'd')
		
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				unstake: 1,
				group_key: 'g1',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.bounced).to.be.true
		expect(response.response.error).to.include("pool asset key a31 not found in the indicated group")
	})

	it('Alice moves her VP from pool2-deposit-aa to g1', async () => {
		const a31_vp = this.pool_vps_g2.a31
		console.log({ a31_vp })
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				vote_shares: 1,
				group_key1: 'g1',
				group_key2: 'g2',
				changes: { a1: 0.85 * a31_vp, a2: 0.15 * a31_vp, a31: -a31_vp },
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		expect(vars['votes_' + this.aliceAddress].a31).to.be.undefined
		expect(vars['pool_vps_g2']).to.be.deep.eq({ total: 0, a31: 0 });
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice withdraws her stake', async () => {
		
		const { vars: initial_vars } = await this.alice.readAAStateVars(this.oswap_aa)
		const balance = initial_vars['user_' + this.aliceAddress].balance

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.oswap_aa,
			amount: 10000,
			data: {
				unstake: 1,
				group_key: 'g1',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: balance,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})

	it('Alice buys more tokens', async () => {
		await this.timetravel('1d')
		const amount = 10e9
		const { new_price, swap_fee, arb_profit_tax, total_fee, coef_multiplier, payout, delta_s, delta_reserve } = await this.get_exchange_result(0, amount);
		expect(payout).to.be.false
		expect(delta_reserve).to.be.gt(0)

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.reserve_asset]: [{ address: this.oswap_aa, amount: amount + this.network_fee_on_top }],
				...this.bounce_fees
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		expect(response.response.responseVars.price).to.eq(new_price)
		expect(response.response.responseVars.swap_fee).to.eq(swap_fee)
		expect(response.response.responseVars.arb_profit_tax).to.eq(arb_profit_tax)
		expect(response.response.responseVars.total_fee).to.eq(total_fee)
		expect(response.response.responseVars.coef_multiplier).to.eq(coef_multiplier)
		expect(response.response.responseVars['fee%']).to.eq((+(total_fee / amount * 100).toFixed(4)) + '%')

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: Math.floor(delta_s),
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
		this.checkVotes(vars)
	})


	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
