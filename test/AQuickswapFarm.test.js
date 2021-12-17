const {
  BN,
  ether,
  expectRevert,
  time,
  constants,
} = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const {
  DS_PROXY_REGISTRY,
  QUICKSWAP_WETH_QUICK,
  QUICKSWAP_WETH_QUICK_PROVIDER,
  QUICKSWAP_DQUICK,
  QUICKSWAP_DQUICK_PROVIDER,
  QUICKSWAP_STAKING_REWARD_FACTORY,
} = require('./utils/constants');

const {
  evmRevert,
  evmSnapshot,
  profileGas,
  getCallData,
  getActionReturn,
  expectEqWithinBps,
} = require('./utils/utils');

const AQuickswapFarm = artifacts.require('AQuickswapFarm');
const IDSProxyRegistry = artifacts.require('IDSProxyRegistry');
const IDSProxy = artifacts.require('IDSProxy');
const TaskExecutor = artifacts.require('TaskExecutorMock');
const IToken = artifacts.require('IERC20');
const IDQuick = artifacts.require('IDQuick');

const IStakingRewards = artifacts.require('IStakingRewards');
const IStakingRewardsFactory = artifacts.require('IStakingRewardsFactory');

async function getErc20TokenBalance(tokenAddr, owner) {
  const IErc20Token = await IToken.at(tokenAddr);
  const balance = await IErc20Token.balanceOf.call(owner);

  return balance;
}

async function transferErc20Token(tokenAddr, from, to, amount) {
  const IErc20Token = await IToken.at(tokenAddr);
  await IErc20Token.transfer(to, amount, {
    from: from,
  });
}

contract('AQuickswapFarm', function([_, owner, collector, user, dummy]) {
  const lpTokenAddress = QUICKSWAP_WETH_QUICK;
  const lpTokenProvider = QUICKSWAP_WETH_QUICK_PROVIDER;
  const fee = new BN('2000'); // 20% harvest fee

  let initialEvmId;
  before(async function() {
    initialEvmId = await evmSnapshot();

    this.lpToken = await IToken.at(lpTokenAddress);
    this.dQuick = await IDQuick.at(QUICKSWAP_DQUICK);

    this.stakingRewardsFactory = await IStakingRewardsFactory.at(
      QUICKSWAP_STAKING_REWARD_FACTORY
    );

    // staking rewards contract info, for fetching expect reward
    const stakingRewardsInfo = await this.stakingRewardsFactory.stakingRewardsInfoByStakingToken.call(
      this.lpToken.address
    );
    this.stakingRewardsContract = await IStakingRewards.at(
      stakingRewardsInfo.stakingRewards
    );

    // create QuickswapFarm action.
    this.aQuickswapFarm = await AQuickswapFarm.new(owner, collector, fee);

    // Create user dsproxy
    this.dsRegistry = await IDSProxyRegistry.at(DS_PROXY_REGISTRY);
    const dsProxyAddr = await this.dsRegistry.proxies.call(user);
    if (dsProxyAddr == constants.ZERO_ADDRESS) {
      await this.dsRegistry.build(user);
    }
    this.userProxy = await IDSProxy.at(
      await this.dsRegistry.proxies.call(user)
    );

    // Create task executor
    this.executor = await TaskExecutor.new(owner);
  });

  beforeEach(async function() {
    id = await evmSnapshot();
  });

  afterEach(async function() {
    await evmRevert(id);
  });

  after(async function() {
    await evmRevert(initialEvmId);
  });

  describe('collector', function() {
    it('has an collector', async function() {
      expect(await this.aQuickswapFarm.collector()).to.equal(collector);
    });
  });

  describe('stake', function() {
    it('stake LP token to mining pool', async function() {
      // Send LP token to user dsproxy
      const lpAmount = ether('1');
      await transferErc20Token(
        this.lpToken.address,
        lpTokenProvider,
        this.userProxy.address,
        lpAmount
      );

      // prepare data
      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'stake', [lpTokenAddress, lpAmount]),
      ]);

      // stake
      await this.userProxy.execute(this.executor.address, data, {
        from: user,
      });

      // After stake all amount, LP token should be 0
      const lpAmountAfter = await getErc20TokenBalance(
        this.lpToken.address,
        this.userProxy.address
      );
      expect(lpAmountAfter).to.be.bignumber.zero;
    });

    it('should revert with zero LP token', async function() {
      // prepare data
      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'stake', [lpTokenAddress, ether('1')]),
      ]);

      // LP token should be 0
      const lpAmount = await getErc20TokenBalance(
        this.lpToken.address,
        this.userProxy.address
      );
      expect(lpAmount).to.be.bignumber.zero;

      expectRevert(
        this.userProxy.execute(this.executor.address, data, {
          from: user,
        }),
        'stake: SafeERC20: low-level call failed'
      );
    });

    it('should revert with insuifficient LP token', async function() {
      // prepare data
      const stakeAmount = ether('1');
      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'stake', [lpTokenAddress, stakeAmount]),
      ]);

      // Send LP token to user dsproxy
      await transferErc20Token(
        this.lpToken.address,
        lpTokenProvider,
        this.userProxy.address,
        stakeAmount.sub(new BN('1'))
      );

      // LP token should less than stakeAmount
      const lpAmount = await getErc20TokenBalance(
        this.lpToken.address,
        this.userProxy.address
      );
      expect(lpAmount).to.be.bignumber.lt(stakeAmount);

      expectRevert(
        this.userProxy.execute(this.executor.address, data, {
          from: user,
        }),
        'stake: SafeERC20: low-level call failed'
      );
    });

    it('should revert with staking wrong LP token', async function() {
      const lpAmount = ether('1');
      // prepare data
      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'stake', [dummy, lpAmount]),
      ]);

      // stake
      await expectRevert(
        this.userProxy.execute(this.executor.address, data, {
          from: user,
        }),
        '_getStakingRewardsContract: StakingRewards contract not found'
      );
    });
  });

  describe('get reward', function() {
    beforeEach(async function() {
      // stake token before each test.
      const lpAmount = ether('10');

      await transferErc20Token(
        this.lpToken.address,
        lpTokenProvider,
        this.userProxy.address,
        lpAmount
      );

      let data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'stake', [this.lpToken.address, lpAmount]),
      ]);

      // stake
      await this.userProxy.execute(this.executor.address, data, {
        from: user,
      });

      // increase time 14 days in order to get reward
      await time.increase(time.duration.days(14));
    });

    it('get reward', async function() {
      // expect reward
      const expectReward = await this.stakingRewardsContract.earned.call(
        this.userProxy.address
      );

      const rewardAmountBefore = await getErc20TokenBalance(
        QUICKSWAP_DQUICK,
        this.userProxy.address
      );

      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'getReward', [lpTokenAddress]),
      ]);

      // getReward
      const receipt = await this.userProxy.execute(
        this.executor.address,
        data,
        {
          from: user,
        }
      );

      const userReward = getActionReturn(receipt, ['uint256'])[0];

      const rewardAmountAfter = await getErc20TokenBalance(
        QUICKSWAP_DQUICK,
        this.userProxy.address
      );

      // reward should >= expectRewards
      expect(userReward).to.be.bignumber.gte(expectReward);

      expect(rewardAmountAfter).to.be.bignumber.gt(rewardAmountBefore);
      expect(rewardAmountAfter.sub(rewardAmountBefore)).to.be.bignumber.gte(
        expectReward
      );
    });

    it('get reward and charge', async function() {
      // total reward
      const totalReward = await this.stakingRewardsContract.earned.call(
        this.userProxy.address
      );

      const expectCollectorReward = totalReward
        .mul(await this.aQuickswapFarm.harvestFee.call())
        .div(await this.aQuickswapFarm.FEE_BASE.call());
      const expectUserReward = totalReward.sub(expectCollectorReward);

      const rewardAmountBefore = await getErc20TokenBalance(
        QUICKSWAP_DQUICK,
        this.userProxy.address
      );

      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'getRewardAndCharge', [lpTokenAddress]),
      ]);

      // getRewardAndCharge
      const receipt = await this.userProxy.execute(
        this.executor.address,
        data,
        {
          from: user,
        }
      );

      const userReward = getActionReturn(receipt, ['uint256'])[0];

      const rewardAmountAfter = await getErc20TokenBalance(
        QUICKSWAP_DQUICK,
        this.userProxy.address
      );

      // user reward should close to expectUserReward
      expect(userReward).to.be.bignumber.gte(expectUserReward);

      expect(rewardAmountAfter).to.be.bignumber.gt(rewardAmountBefore);
      expect(rewardAmountAfter.sub(rewardAmountBefore)).to.be.bignumber.gte(
        expectUserReward
      );

      // collector reward should close to expectCollectorReward
      const collectorReward = await getErc20TokenBalance(
        QUICKSWAP_DQUICK,
        collector
      );
      expectEqWithinBps(collectorReward, expectCollectorReward.toString(), 5);
    });
  });

  describe('dQuick leave', async function() {
    it('dQuick leave', async function() {
      // transfer dQuick to user proxy
      const dQuickAmount = ether('5');
      await transferErc20Token(
        this.dQuick.address,
        QUICKSWAP_DQUICK_PROVIDER,
        this.userProxy.address,
        dQuickAmount
      );

      // leave
      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'dQuickLeave', [dQuickAmount]),
      ]);
      const receipt = await this.userProxy.execute(
        this.executor.address,
        data,
        {
          from: user,
        }
      );
      const userQuickAmount = getActionReturn(receipt, ['uint256'])[0];

      // get estimate Quick amount
      const estimateQuickAmount = await this.dQuick.dQUICKForQUICK.call(
        dQuickAmount
      );

      // check
      expectEqWithinBps(userQuickAmount, estimateQuickAmount, 5);
    });

    it('should revert with 0 dQuick', async function() {
      // leave
      const data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'dQuickLeave', [0]),
      ]);

      // should fail
      expectRevert(
        this.userProxy.execute(this.executor.address, data, {
          from: user,
        }),
        'dQuickLeave: zero amount'
      );
    });
  });

  describe('exit', async function() {
    it('exit', async function() {
      // transfer lp token
      const lpAmount = ether('5');
      await transferErc20Token(
        this.lpToken.address,
        lpTokenProvider,
        this.userProxy.address,
        lpAmount
      );

      // staking
      let data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'stake', [this.lpToken.address, lpAmount]),
      ]);

      await this.userProxy.execute(this.executor.address, data, {
        from: user,
      });

      // increase time 14 days in order to get reward
      await time.increase(time.duration.days(14));

      const userExpectReward = await this.stakingRewardsContract.earned.call(
        this.userProxy.address
      );

      // exit
      data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'exit', [this.lpToken.address]),
      ]);

      const receipt = await this.userProxy.execute(
        this.executor.address,
        data,
        {
          from: user,
        }
      );

      const actionReturns = getActionReturn(receipt, ['uint256', 'uint256']);
      const userLPAmount = actionReturns[0];
      const userReward = actionReturns[1];

      expect(userLPAmount).to.be.bignumber.eq(lpAmount);
      expect(userReward).to.be.bignumber.gte(userExpectReward);
    });

    it('should revert with 0 lp token staking', async function() {
      // exit
      data = getCallData(TaskExecutor, 'execMock', [
        this.aQuickswapFarm.address,
        getCallData(AQuickswapFarm, 'exit', [this.lpToken.address]),
      ]);

      expectRevert(
        this.userProxy.execute(this.executor.address, data, {
          from: user,
        }),
        'exit: Cannot withdraw 0'
      );
    });
  });

  describe('aaa', async function() {
    it('aaa', async function() {
      const a = ether('1');
      console.log(a.toString());
      const b = a.sub(new BN('1'));
      console.log(b.toString());
    });
  });
});
