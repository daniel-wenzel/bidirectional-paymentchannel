pragma solidity ^0.4.0;

contract BidirectionalPaymentChannel {

	address public partyA;
	address public partyB;

	// the balance is the amount of money that partyB owns
	uint256 public closingBalance;
	uint256 public closingMessageNumber = 0;
	uint256 public closingDate;

	bool public partyAapproves = false;
	bool public partyBapproves = false;

	bool public channelClosing = false;

	bool public paidOutToA = false;
	bool public paidOutToB = false;

	uint256 public settlementPeriod;

	bool public dev;
	uint256 public currentTime_dev; //variable for time mocking in tests, only used when dev = true

	modifier onlyByParties()
	{
			require(msg.sender == partyA || msg.sender == partyB);
			_;
	}

	modifier channelIsClosed() {
		require((partyAapproves && partyBapproves) || (channelClosing && closingDate + settlementPeriod < currentTime()));
		_;
	}

	modifier channelIsNotClosed() {
		require(!(partyAapproves && partyBapproves));
		require(!(channelClosing && currentTime() > closingDate + settlementPeriod));
		_;
	}

	function BidirectionalPaymentChannel(address to, uint256 _settlementPeriod, uint256 initialBalanceOfB, bool _dev) public payable  {
		require(initialBalanceOfB <= msg.value);

		partyB = to;
		partyA = msg.sender;

		closingBalance = initialBalanceOfB;
		settlementPeriod = _settlementPeriod;

		dev = _dev;
	}
	//if a payment channel is closed and a party refuses to cooperate before the first message is signed by both, funds would be locked. In this case, this method can be used to close the channel with the initial balance
	function closeWithInitalBalance() public onlyByParties channelIsNotClosed{
		// no one must have send a newer message to close the channel
		require(closingMessageNumber == 0);

		// close the channel with message no 0 and a the initial balance as closing balance
		setPartyClosesChannel(0, closingBalance);
	}
	function close(bytes32 msgHash, uint8 v_partyA, bytes32 r_partyA, bytes32 s_partyA, uint8 v_partyB, bytes32 r_partyB, bytes32 s_partyB, uint256 messageNo, uint256 balance) external onlyByParties channelIsNotClosed{
		//1. check if the message hash is correct
		bytes32 proof = keccak256(this, messageNo, balance);
		require(msgHash == proof);

		// web3 automatically adds this prefix to every signed message to prevent identity theft
		bytes memory prefix = "\x19Ethereum Signed Message:\n32";
		bytes32 prefixedHash = keccak256(prefix, msgHash);

		//2. check if the signature of partyA is valid
		address signerA = ecrecover(prefixedHash, v_partyA, r_partyA, s_partyA);
		require(signerA == partyA);

		//3. Check if the signature of partyB is valid
		address signerB = ecrecover(prefixedHash, v_partyB, r_partyB, s_partyB);
		require(signerB == partyB);

		//3. check if this message is newer than the newest message in the payment channel
		// <= because we want to allow double signing to close a channel early
		require(closingMessageNumber <= messageNo);

		setPartyClosesChannel(messageNo, balance);
	}
	function setPartyClosesChannel(uint256 messageNo, uint256 balance) internal {
		require(balance < this.balance);

		if (!channelClosing || messageNo != closingMessageNumber) {
			closingMessageNumber = messageNo;
			closingDate = currentTime();
			closingBalance = balance;
			channelClosing = true;

			partyAapproves = false;
			partyBapproves = false;
		}
		if (msg.sender == partyA) {
			partyAapproves = true;
		}
		else {
			partyBapproves = true;
		}
	}

	function payout() external onlyByParties channelIsClosed{

		if (partyA == msg.sender) {
			paidOutToA = true;
			partyA.transfer(this.balance - closingBalance);
		} else {
			paidOutToB = true;
			partyB.transfer(closingBalance);
		}
	}

	function currentTime() public returns (uint256) {
		if (dev) {
			return currentTime_dev;
		}
		else {
			return now;
		}
	}

	function setCurrentTime(uint256 time) external {
		require(dev);
		currentTime_dev = time;
	}
}
