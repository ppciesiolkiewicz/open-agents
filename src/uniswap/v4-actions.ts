import { encodeAbiParameters, encodePacked, type Hex } from 'viem';
import {
  UNIVERSAL_ROUTER_V4_SWAP_COMMAND,
  V4_ACTION,
} from '../constants';
import type { PoolKey } from './types';

const EXACT_INPUT_SINGLE_PARAMS = {
  type: 'tuple',
  components: [
    {
      name: 'poolKey',
      type: 'tuple',
      components: [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'hooks', type: 'address' },
      ],
    },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const;

const CURRENCY_AMOUNT_PARAMS = [
  { name: 'currency', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;

export interface BuildV4SwapInputArgs {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  inputCurrency: `0x${string}`;
  outputCurrency: `0x${string}`;
}

export function buildV4ExactInputSingleInput(args: BuildV4SwapInputArgs): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL],
  );

  const swapParams = encodeAbiParameters(
    [EXACT_INPUT_SINGLE_PARAMS],
    [
      {
        poolKey: args.poolKey,
        zeroForOne: args.zeroForOne,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMinimum,
        hookData: '0x',
      },
    ],
  );

  const settleParams = encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [
    args.inputCurrency,
    args.amountIn,
  ]);

  const takeParams = encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [
    args.outputCurrency,
    args.amountOutMinimum,
  ]);

  return encodeAbiParameters(
    [
      { name: 'actions', type: 'bytes' },
      { name: 'params', type: 'bytes[]' },
    ],
    [actions, [swapParams, settleParams, takeParams]],
  );
}

export function buildUniversalRouterV4Swap(args: BuildV4SwapInputArgs): {
  commands: Hex;
  inputs: [Hex];
} {
  return {
    commands: encodePacked(['uint8'], [UNIVERSAL_ROUTER_V4_SWAP_COMMAND]),
    inputs: [buildV4ExactInputSingleInput(args)],
  };
}
