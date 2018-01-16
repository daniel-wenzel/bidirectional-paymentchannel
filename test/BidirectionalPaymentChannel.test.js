const sha3 = require('solidity-sha3').default
const Channel = artifacts.require("./BidirectionalPaymentChannel.sol");
const ethUtil = require('ethereumjs-util')

const should = require('should')
const expect = require('expect')

contract('Channel', function(accounts) {
  let testChannel;
  const defaultData = {
    settlementPeriod: 60*60*24,
    totalBalance: web3.toWei(1, "ether"),
    balanceOfB: web3.toWei(0.2, "ether"),
    accountOfB: accounts[1]
  }
  beforeEach(async function() {
    testChannel = await Channel.new(defaultData.accountOfB, defaultData.settlementPeriod, defaultData.balanceOfB, true, {value: defaultData.totalBalance })
  })
  it ("should be possible to open a payment channel", async function() {
    const testContract = await Channel.new(accounts[1], 60*60*24, web3.toWei(0.5, "ether"), false, {value: web3.toWei(1, "ether") });
  })
  it ("should not be possible to open a payment channel with a too high balance for party b", async function() {
    try {
      const testContract = await Channel.new(accounts[1], 60*60*24, web3.toWei(1.01, "ether"), false, {value: web3.toWei(1, "ether") });
      should.fail("balance was too high");
    }
    catch (e) {
      expect(e.message).toContain("VM Exception while processing transaction: ")
    }
  })
  it ("should not be possible to mock the time of a contract with dev = false", async function() {
    const testContract = await Channel.new(accounts[1], 60*60*24, web3.toWei(0.5, "ether"), false, {value: web3.toWei(1, "ether") });
    try {
      await testContract.setCurrentTime.sendTransaction(1000)
      should.fail("Setting current time should not be possible");
    }
    catch (e) {
      expect(e.message).toContain("VM Exception while processing transaction: ")
    }
    expect(+await testContract.currentTime.call()).toBeCloseTo(new Date().getTime()/1000, -1)
  })
  it("should be possible to close the channel with the initial balance and wait out the settlement period", async () => {
    await testChannel.closeWithInitalBalance.sendTransaction({from: accounts[1]})
    await testChannel.setCurrentTime.sendTransaction(defaultData.settlementPeriod+1, {from: accounts[1]})
    expect(await getBalanceChangeFromTransaction(testChannel.payout.sendTransaction, accounts[0])).toBeGreaterThan(web3.fromWei(defaultData.balanceOfA, "ether")*0.9) // minus cost
    expect(await getBalanceChangeFromTransaction(testChannel.payout.sendTransaction, accounts[1])).toBeGreaterThan(web3.fromWei(defaultData.balanceOfB, "ether")*0.9) // minus cost
  })

  it("should be possible to close the channel when both parties agree on a final", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[0])
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[1])
    await testChannel.payout.sendTransaction()
  })

  it("should not be possible for a third party to close a channel", async () => {
    await expectInvalidOptcode(testChannel.closeWithInitalBalance.sendTransaction({from: accounts[2]}))
    await expectInvalidOptcode(sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[2]))
  })

  it("should not be possible to get a payout before the settlement period is over or both parties agreed", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[0])
    await expectInvalidOptcode(testChannel.payout())
  })
  it("should not be possible to get a payout before anybody tried to close the channel", async () => {
    await expectInvalidOptcode(testChannel.payout())
  })

  it("should not be possible to close with a higher message, after the settlementPeriod is over", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[0])
    await testChannel.setCurrentTime(defaultData.settlementPeriod+1)
    await expectInvalidOptcode(sendValidCloseChannelMessage(4, web3.toWei(0.3, "ether"), accounts[1]))
  })

  it("should not be possible to close with a higher message, after both parties agreed on an earlier message", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[0])
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[1])
    await testChannel.setCurrentTime(defaultData.settlementPeriod+1)
    await expectInvalidOptcode(sendValidCloseChannelMessage(4, web3.toWei(0.3, "ether"), accounts[1]))
  })
  it("should not be possible to close a channel with a message with a lower number", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0.4, "ether"), accounts[0])

    await expectInvalidOptcode(sendValidCloseChannelMessage(2, web3.toWei(0.3, "ether"), accounts[1]))
    await expectInvalidOptcode(testChannel.closeWithInitalBalance.sendTransaction({from: accounts[1]}))
  })

  it("accepts a higher message from partyB when partyA already approves", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0, "ether"), accounts[0])
    await sendValidCloseChannelMessage(4, web3.toWei(0.9, "ether"), accounts[1])

    await testChannel.setCurrentTime(defaultData.settlementPeriod+1)
    expect(await getBalanceChangeFromTransaction(testChannel.payout.sendTransaction, accounts[1])).toBeGreaterThan(web3.fromWei(1, "ether")*0.9) // minus cost

  })

  it("accepts a higher message from partyA when partyB already approves", async () => {
    await sendValidCloseChannelMessage(3, web3.toWei(0.9, "ether"), accounts[1])
    await sendValidCloseChannelMessage(4, web3.toWei(0, "ether"), accounts[0])

    await testChannel.setCurrentTime(defaultData.settlementPeriod+1)
    expect(await getBalanceChangeFromTransaction(testChannel.payout.sendTransaction, accounts[0])).toBeGreaterThan(web3.fromWei(1, "ether")*0.9) // minus cost
  })
  it("can not be closed with a balance thats higher than all the money in the contract", async () => {
    await expectInvalidOptcode(sendValidCloseChannelMessage(3, web3.toWei(1.1, "ether"), accounts[1]))
  })

  it("can not be closed with an invalid hash", async () => {
    const messageNo = 3;
    const balanceInWei = web3.toWei(0.33, "ether")
    const hash = hashState(testChannel, messageNo, balanceInWei)
    const sigA = await signHash(hash, accounts[0])
    const sigB = await signHash(hash, accounts[1])

    await expectInvalidOptcode(testChannel.close.sendTransaction(hash, sigA.v, sigA.r, sigA.s, sigB.v, sigB.r, sigB.s, messageNo+1, balanceInWei, {from:accounts[0]}))
    await expectInvalidOptcode(testChannel.close.sendTransaction(hash, sigA.v, sigA.r, sigA.s, sigB.v, sigB.r, sigB.s, messageNo, balanceInWei+1, {from:accounts[0]}))
  })
  it("can not be closed with invalid signatures", async () => {
    const messageNo = 3;
    const balanceInWei = web3.toWei(0.33, "ether")
    const hash = hashState(testChannel, messageNo, balanceInWei)
    const sigA = await signHash(hash, accounts[0])
    const sigB = await signHash(hash, accounts[1])
    const sig_invalid = await signHash(hash, accounts[2])
    await expectInvalidOptcode(testChannel.close.sendTransaction(hash, sig_invalid.v, sig_invalid.r, sig_invalid.s, sigB.v, sigB.r, sigB.s, messageNo, balanceInWei, {from:accounts[0]}))
    await expectInvalidOptcode(testChannel.close.sendTransaction(hash, sigA.v, sigA.r, sigA.s, sig_invalid.v, sig_invalid.r, sig_invalid.s, messageNo, balanceInWei, {from:accounts[0]}))

  })

  async function expectInvalidOptcode(promise, message) {
    try {
      await promise
      should.fail("this promise should have thrown an error")
    }
    catch(e) {
      expect(e.message).toContain("VM Exception while processing transaction:")
    }
  }
  async function getBalanceChangeFromTransaction(transaction, account) {
    const balanceBeforePayout = +web3.eth.getBalance(account)
    await transaction({from: account})
    const balanceAfterPayout = +web3.eth.getBalance(account)
    return +web3.fromWei(balanceAfterPayout-balanceBeforePayout, "ether")
  }

  async function sendValidCloseChannelMessage(messageNo, balanceInWei, account) {

    const hash = hashState(testChannel, messageNo, balanceInWei)
    const sigA = await signHash(hash, accounts[0])
    const sigB = await signHash(hash, accounts[1])

    await testChannel.close.sendTransaction(hash, sigA.v, sigA.r, sigA.s, sigB.v, sigB.r, sigB.s, messageNo, balanceInWei, {from:account})
  }

  function hashState(contract, messageNo, balance) {
    return sha3(contract.address, +messageNo, +balance)
  }
  async function signHash(hash, account) {
    const signature = await web3.eth.sign(account, hash)
    const signatureData = ethUtil.fromRpcSig(signature)
    return {
      v: ethUtil.bufferToHex(signatureData.v),
      r: ethUtil.bufferToHex(signatureData.r),
      s: ethUtil.bufferToHex(signatureData.s)
    }
  }
});
