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
			.with.wallet({ oracle: {base: 1e9} })
			.with.wallet({ alice: {base: 1000e9, pool1: 1000e9, pool2: 10000e9} })
			.with.wallet({ bob: {base: 1000e9, pool1: 1000e9, pool2: 10000e9} })
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
		await this.network.timetravel({ to: '2022-12-01' })
		
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
		expect(oswap_vars['user_' + this.bobAddress]).to.be.deep.eq({
			balance: amount,
			reward: 0,
			normalized_vp: amount * 4 ** ((response.timestamp - this.common_ts)/360/24/3600),
			last_stakers_emissions: 0,
			expiry_ts: response.timestamp + 4 * 360 * 24 * 3600,
		});

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.oswap_aa,
				amount: amount,
			},
		])
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
		}, 0.001);

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.oswap_aa,
				amount: amount,
			},
		])
	})


	it('Alice buys tokens', async () => {
		const amount = 100e9
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

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/
		this.new_issued_shares = unitObj.messages.find(m => m.app === 'payment' && m.payload.asset === this.asset).payload.outputs.find(o => o.address === this.aliceAddress).amount

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
	})



	it('Alice sells tokens', async () => {
		const amount = Math.floor(this.new_issued_shares/2)
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

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
	})

	it('Alice stakes tokens', async () => {
		const amount = Math.floor(this.new_issued_shares/2)
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

		this.checkCurve()
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
	})


	it('Bob deposits pool tokens', async () => {
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
	})
	
	
	it('Bob harvests LP rewards', async () => {
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
		this.state = vars.state

		this.checkCurve()
	})
	
	it('Bob withdraws LP tokens and harvests LP rewards', async () => {
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
		this.state = vars.state

		this.checkCurve()
	})
	
	it('Alice capitalizes her reward and extends the lock', async () => {
		await this.timetravel('180d')
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
		this.state = vars.state

		this.checkCurve()
	})

	it('Alice withdraws her stake', async () => {
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
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
	})

	it('Alice buys more tokens', async () => {
		await this.timetravel('1d')
		const amount = 10e9
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

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(Utils.getExternalPayments(unitObj))
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])*/

		const { vars } = await this.alice.readAAStateVars(this.oswap_aa)
		console.log(vars)
		this.state = vars.state

		this.checkCurve()
	})


	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
