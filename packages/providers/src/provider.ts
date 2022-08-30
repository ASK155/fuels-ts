/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { BytesLike } from '@ethersproject/bytes';
import { arrayify, hexlify } from '@ethersproject/bytes';
import type { Network } from '@ethersproject/networks';
import type { InputValue } from '@fuel-ts/abi-coder';
import { AbiCoder } from '@fuel-ts/abi-coder';
import { NativeAssetId } from '@fuel-ts/constants';
import type { AbstractAddress, AbstractPredicate } from '@fuel-ts/interfaces';
import type { BigNumberish } from '@fuel-ts/math';
import { max, multiply } from '@fuel-ts/math';
import type { Transaction } from '@fuel-ts/transactions';
import {
  GAS_PRICE_FACTOR,
  MAX_GAS_PER_TX,
  ReceiptType,
  ReceiptCoder,
  TransactionCoder,
} from '@fuel-ts/transactions';
import { GraphQLClient } from 'graphql-request';
import cloneDeep from 'lodash.clonedeep';

import type {
  GqlChainInfoFragmentFragment,
  GqlGetInfoQuery,
  GqlReceiptFragmentFragment,
} from './__generated__/operations';
import { getSdk as getOperationsSdk } from './__generated__/operations';
import type { Coin } from './coin';
import type { CoinQuantity, CoinQuantityLike } from './coin-quantity';
import { coinQuantityfy } from './coin-quantity';
import { ScriptTransactionRequest, transactionRequestify } from './transaction-request';
import type { TransactionRequestLike } from './transaction-request';
import type {
  TransactionResult,
  TransactionResultReceipt,
} from './transaction-response/transaction-response';
import { TransactionResponse } from './transaction-response/transaction-response';
import { calculatePriceWithFactor, getGasUsedFromReceipts } from './util';

export type CallResult = {
  receipts: TransactionResultReceipt[];
};

/**
 * A Fuel block
 */
export type Block = {
  id: string;
  height: bigint;
  time: string;
  producer: string;
  transactionIds: string[];
};

/**
 * Deployed Contract bytecode and contract id
 */
export type ContractResult = {
  id: string;
  bytecode: string;
};

/**
 * Chain information
 */
export type ChainInfo = {
  name: string;
  baseChainHeight: bigint;
  peerCount: number;
  consensusParameters: {
    gasPriceFactor: bigint;
    maxGasPerTx: bigint;
    maxScriptLength: bigint;
  };
  latestBlock: {
    id: string;
    height: bigint;
    producer: string;
    time: string;
    transactions: Array<{ id: string }>;
  };
};

/**
 * Node information
 */
export type NodeInfo = {
  minBytePrice: bigint;
  minGasPrice: bigint;
  nodeVersion: string;
};

export type TransactionCost = {
  minGasPrice: bigint;
  minBytePrice: bigint;
  gasPrice: bigint;
  bytePrice: bigint;
  byteSize: bigint;
  gasUsed: bigint;
  fee: bigint;
};

const processGqlReceipt = (gqlReceipt: GqlReceiptFragmentFragment): TransactionResultReceipt => {
  const receipt = new ReceiptCoder().decode(arrayify(gqlReceipt.rawPayload), 0)[0];

  switch (receipt.type) {
    case ReceiptType.ReturnData: {
      return {
        ...receipt,
        data: gqlReceipt.data!,
      };
    }
    case ReceiptType.LogData: {
      return {
        ...receipt,
        data: gqlReceipt.data!,
      };
    }
    default:
      return receipt;
  }
};

const processGqlChain = (chain: GqlChainInfoFragmentFragment): ChainInfo => ({
  name: chain.name,
  baseChainHeight: BigInt(chain.baseChainHeight),
  peerCount: chain.peerCount,
  consensusParameters: {
    gasPriceFactor: BigInt(chain.consensusParameters.gasPriceFactor),
    maxGasPerTx: BigInt(chain.consensusParameters.maxGasPerTx),
    maxScriptLength: BigInt(chain.consensusParameters.maxScriptLength),
  },
  latestBlock: {
    id: chain.latestBlock.id,
    height: BigInt(chain.latestBlock.height),
    producer: chain.latestBlock.producer,
    time: chain.latestBlock.time,
    transactions: chain.latestBlock.transactions.map((i) => ({
      id: i.id,
    })),
  },
});

const processNodeInfo = (nodeInfo: GqlGetInfoQuery['nodeInfo']) => ({
  minBytePrice: BigInt(nodeInfo.minBytePrice),
  minGasPrice: BigInt(nodeInfo.minGasPrice),
  nodeVersion: nodeInfo.nodeVersion,
});

/**
 * Cursor pagination arguments
 *
 * https://relay.dev/graphql/connections.htm#sec-Arguments
 */
export type CursorPaginationArgs = {
  /** Forward pagination limit */
  first?: number | null;
  /** Forward pagination cursor */
  after?: string | null;
  /** Backward pagination limit  */
  last?: number | null;
  /** Backward pagination cursor */
  before?: string | null;
};

export type BuildPredicateOptions = {
  fundTransaction?: boolean;
} & Pick<TransactionRequestLike, 'gasLimit' | 'gasPrice' | 'bytePrice' | 'maturity'>;

/**
 * Provider Call transaction params
 */
export type ProviderCallParams = {
  utxoValidation?: boolean;
};
/**
 * A provider for connecting to a Fuel node
 */
export default class Provider {
  operations: ReturnType<typeof getOperationsSdk>;

  constructor(
    /** GraphQL endpoint of the Fuel node */
    public url: string
  ) {
    const gqlClient = new GraphQLClient(url);
    this.operations = getOperationsSdk(gqlClient);
  }

  /**
   * Returns the version of the connected Fuel node
   */
  async getVersion(): Promise<string> {
    const {
      nodeInfo: { nodeVersion },
    } = await this.operations.getVersion();
    return nodeVersion;
  }

  /**
   * Returns the network configuration of the connected Fuel node
   */
  async getNetwork(): Promise<Network> {
    return {
      name: 'fuelv2',
      chainId: 0xdeadbeef,
    };
  }

  /**
   * Returns the current block number
   */
  async getBlockNumber(): Promise<bigint> {
    const { chain } = await this.operations.getChain();
    return BigInt(chain.latestBlock.height);
  }

  /**
   * Returns node information
   */
  async getNodeInfo(): Promise<NodeInfo> {
    const { nodeInfo } = await this.operations.getInfo();
    return processNodeInfo(nodeInfo);
  }

  /**
   * Returns chain information
   */
  async getChain(): Promise<ChainInfo> {
    const { chain } = await this.operations.getChain();
    return processGqlChain(chain);
  }

  /**
   * Submits a transaction to the chain to be executed
   */
  async sendTransaction(
    transactionRequestLike: TransactionRequestLike
  ): Promise<TransactionResponse> {
    const transactionRequest = transactionRequestify(transactionRequestLike);
    const encodedTransaction = hexlify(transactionRequest.toTransactionBytes());
    const { gasUsed, minGasPrice, minBytePrice } = await this.getTransactionCost(
      transactionRequest,
      0
    );

    // Fail transaction before submit to avoid submit failure
    // Resulting in lost of funds on a OutOfGas situation.
    if (gasUsed > transactionRequest.gasLimit) {
      throw new Error(
        `gasLimit(${transactionRequest.gasLimit}) is lower than the required (${gasUsed})`
      );
    } else if (minGasPrice > transactionRequest.gasPrice) {
      throw new Error(
        `gasPrice(${transactionRequest.gasPrice}) is lower than the required ${minGasPrice}`
      );
    } else if (minBytePrice > transactionRequest.bytePrice) {
      throw new Error(
        `bytePrice(${transactionRequest.bytePrice}) is lower than the required ${minBytePrice}`
      );
    }

    const {
      submit: { id: transactionId },
    } = await this.operations.submit({ encodedTransaction });

    const response = new TransactionResponse(transactionId, transactionRequest, this);
    return response;
  }

  /**
   * Executes a transaction without actually submitting it to the chain
   */
  async call(
    transactionRequestLike: TransactionRequestLike,
    { utxoValidation }: ProviderCallParams = {}
  ): Promise<CallResult> {
    const transactionRequest = transactionRequestify(transactionRequestLike);
    const encodedTransaction = hexlify(transactionRequest.toTransactionBytes());
    const { dryRun: gqlReceipts } = await this.operations.dryRun({
      encodedTransaction,
      utxoValidation: utxoValidation || false,
    });
    const receipts = gqlReceipts.map(processGqlReceipt);
    return {
      receipts,
    };
  }

  /**
   * Returns a transaction cost to enable user
   * to set gasLimit and also reserve balance amounts
   * on the the transaction.
   *
   * The tolerance is add on top of the gasUsed calculated
   * from the node, this create a safe margin costs like
   * change states on transfer that don't occur on the dryRun
   * transaction. The default value is 0.2 or 20%
   */
  async getTransactionCost(
    transactionRequestLike: TransactionRequestLike,
    tolerance: number = 0.2
  ): Promise<TransactionCost> {
    const transactionRequest = transactionRequestify(cloneDeep(transactionRequestLike));
    const { minBytePrice, minGasPrice } = await this.getNodeInfo();
    const gasPrice = max(transactionRequest.gasPrice, minGasPrice);
    const bytePrice = max(transactionRequest.bytePrice, minBytePrice);
    const margin = 1 + tolerance;

    // Set gasLimit to the maximum of the chain
    // and bytePrice and gasPrice to 0 for measure
    // Transaction without arrive to OutOfGas
    transactionRequest.gasLimit = MAX_GAS_PER_TX;
    transactionRequest.bytePrice = 0n;
    transactionRequest.gasPrice = 0n;

    // Execute dryRun not validated transaction to query gasUsed
    const { receipts } = await this.call(transactionRequest);
    const gasUsed = multiply(getGasUsedFromReceipts(receipts), margin);
    const byteSize = transactionRequest.chargeableByteSize();
    const gasFee = calculatePriceWithFactor(gasUsed, gasPrice, GAS_PRICE_FACTOR);
    const byteFee = calculatePriceWithFactor(byteSize, bytePrice, GAS_PRICE_FACTOR);

    return {
      minGasPrice,
      minBytePrice,
      bytePrice,
      gasPrice,
      gasUsed,
      byteSize,
      fee: byteFee + gasFee,
    };
  }

  /**
   * Returns coins for the given owner
   */
  async getCoins(
    /** The address to get coins for */
    owner: AbstractAddress,
    /** The asset ID of coins to get */
    assetId?: BytesLike,
    /** Pagination arguments */
    paginationArgs?: CursorPaginationArgs
  ): Promise<Coin[]> {
    const result = await this.operations.getCoins({
      first: 10,
      ...paginationArgs,
      filter: { owner: owner.toB256(), assetId: assetId && hexlify(assetId) },
    });

    const coins = result.coins.edges!.map((edge) => edge!.node!);

    return coins.map((coin) => ({
      id: coin.utxoId,
      assetId: coin.assetId,
      amount: BigInt(coin.amount),
      owner: coin.owner,
      status: coin.status,
      maturity: BigInt(coin.maturity),
      blockCreated: BigInt(coin.blockCreated),
    }));
  }

  /**
   * Returns coins for the given owner satisfying the spend query
   */
  async getCoinsToSpend(
    /** The address to get coins for */
    owner: AbstractAddress,
    /** The quantitites to get */
    quantities: CoinQuantityLike[],
    /** Maximum number of coins to return */
    maxInputs?: number,
    /** IDs of coins to exclude */
    excludedIds?: BytesLike[]
  ): Promise<Coin[]> {
    const result = await this.operations.getCoinsToSpend({
      owner: owner.toB256(),
      spendQuery: quantities.map(coinQuantityfy).map((quantity) => ({
        assetId: hexlify(quantity.assetId),
        amount: quantity.amount.toString(),
      })),
      maxInputs,
      excludedIds: excludedIds?.map((id) => hexlify(id)),
    });

    const coins = result.coinsToSpend;

    return coins.map((coin) => ({
      id: coin.utxoId,
      status: coin.status,
      assetId: coin.assetId,
      amount: BigInt(coin.amount),
      owner: coin.owner,
      maturity: BigInt(coin.maturity),
      blockCreated: BigInt(coin.blockCreated),
    }));
  }

  /**
   * Returns block matching the given ID or type
   */
  async getBlock(
    /** ID or height of the block */
    idOrHeight: string | number | 'latest'
  ): Promise<Block | null> {
    let variables;
    if (typeof idOrHeight === 'number') {
      variables = { blockHeight: BigInt(idOrHeight).toString() };
    } else if (idOrHeight === 'latest') {
      variables = { blockHeight: (await this.getBlockNumber()).toString() };
    } else {
      variables = { blockId: idOrHeight };
    }

    const { block } = await this.operations.getBlock(variables);

    if (!block) {
      return null;
    }

    return {
      id: block.id,
      height: BigInt(block.height),
      time: block.time,
      producer: block.producer,
      transactionIds: block.transactions.map((tx) => tx.id),
    };
  }

  /**
   * Returns block matching the given ID or type, including transaction data
   */
  async getBlockWithTransactions(
    /** ID or height of the block */
    idOrHeight: string | number | 'latest'
  ): Promise<(Block & { transactions: Transaction[] }) | null> {
    let variables;
    if (typeof idOrHeight === 'number') {
      variables = { blockHeight: BigInt(idOrHeight).toString() };
    } else if (idOrHeight === 'latest') {
      variables = { blockHeight: (await this.getBlockNumber()).toString() };
    } else {
      variables = { blockId: idOrHeight };
    }

    const { block } = await this.operations.getBlockWithTransactions(variables);

    if (!block) {
      return null;
    }

    return {
      id: block.id,
      height: BigInt(block.height),
      time: block.time,
      producer: block.producer,
      transactionIds: block.transactions.map((tx) => tx.id),
      transactions: block.transactions.map(
        (tx) => new TransactionCoder().decode(arrayify(tx.rawPayload), 0)?.[0]
      ),
    };
  }

  /**
   * Get transaction with the given ID
   */
  async getTransaction(transactionId: string): Promise<Transaction | null> {
    const { transaction } = await this.operations.getTransaction({ transactionId });
    if (!transaction) {
      return null;
    }
    return new TransactionCoder().decode(arrayify(transaction.rawPayload), 0)?.[0];
  }

  /**
   * Get deployed contract with the given ID
   *
   * @returns contract bytecode and contract id
   */
  async getContract(contractId: string): Promise<ContractResult | null> {
    const { contract } = await this.operations.getContract({ contractId });
    if (!contract) {
      return null;
    }
    return contract;
  }

  /**
   * Returns the balance for the given owner for the given asset ID
   */
  async getBalance(
    /** The address to get coins for */
    owner: AbstractAddress,
    /** The asset ID of coins to get */
    assetId: BytesLike
  ): Promise<bigint> {
    const { balance } = await this.operations.getBalance({
      owner: owner.toB256(),
      assetId: hexlify(assetId),
    });
    return BigInt(balance.amount);
  }

  /**
   * Returns balances for the given owner
   */
  async getBalances(
    /** The address to get coins for */
    owner: AbstractAddress,
    /** Pagination arguments */
    paginationArgs?: CursorPaginationArgs
  ): Promise<CoinQuantity[]> {
    const result = await this.operations.getBalances({
      first: 10,
      ...paginationArgs,
      filter: { owner: owner.toB256() },
    });

    const balances = result.balances.edges!.map((edge) => edge!.node!);

    return balances.map((balance) => ({
      assetId: balance.assetId,
      amount: BigInt(balance.amount),
    }));
  }

  async buildSpendPredicate(
    predicate: AbstractPredicate,
    amountToSpend: BigNumberish,
    receiverAddress: AbstractAddress,
    predicateData?: InputValue[],
    assetId: BytesLike = NativeAssetId,
    predicateOptions?: BuildPredicateOptions,
    walletAddress?: AbstractAddress
  ): Promise<ScriptTransactionRequest> {
    const predicateCoins: Coin[] = await this.getCoinsToSpend(predicate.address, [
      [amountToSpend, assetId],
    ]);
    const options = {
      fundTransaction: true,
      ...predicateOptions,
    };
    const request = new ScriptTransactionRequest({
      gasLimit: MAX_GAS_PER_TX,
      ...options,
    });

    let encoded: undefined | Uint8Array;
    if (predicateData && predicate.types) {
      const abiCoder = new AbiCoder();
      encoded = abiCoder.encode(predicate.types, predicateData);
    }

    let totalInPredicate = 0n;
    predicateCoins.forEach((coin: Coin) => {
      totalInPredicate += coin.amount;
      request.addCoin({
        ...coin,
        predicate: predicate.bytes,
        predicateData: encoded,
      } as Coin);
      request.outputs = [];
    });

    // output sent to receiver
    request.addCoinOutput(receiverAddress, totalInPredicate, assetId);

    const requiredCoinQuantities: CoinQuantityLike[] = [];
    if (options.fundTransaction) {
      requiredCoinQuantities.push(request.calculateFee());
    }

    if (requiredCoinQuantities.length && walletAddress) {
      const coins = await this.getCoinsToSpend(walletAddress, requiredCoinQuantities);
      request.addCoins(coins);
    }

    return request;
  }

  async submitSpendPredicate(
    predicate: AbstractPredicate,
    amountToSpend: BigNumberish,
    receiverAddress: AbstractAddress,
    predicateData?: InputValue[],
    assetId: BytesLike = NativeAssetId,
    options?: BuildPredicateOptions,
    walletAddress?: AbstractAddress
  ): Promise<TransactionResult<'success'>> {
    const request = await this.buildSpendPredicate(
      predicate,
      amountToSpend,
      receiverAddress,
      predicateData,
      assetId,
      options,
      walletAddress
    );

    try {
      const response = await this.sendTransaction(request);
      return await response.waitForResult();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const errors: { message: string }[] = error?.response?.errors || [];
      if (
        errors.some(({ message }) =>
          message.includes('unexpected block execution error TransactionValidity(InvalidPredicate')
        )
      ) {
        throw new Error('Invalid Predicate');
      }

      throw error;
    }
  }
}
