import type { PrismaClient } from '@prisma/client';
import type { ZeroGPurchaseRepository } from '../repositories/zero-g-purchase-repository.js';
import type { ZeroGPurchase, ZeroGPurchaseStatus } from '../types.js';

function rowToDomain(row: any): ZeroGPurchase {
  return {
    id: row.id,
    userId: row.userId,
    userWalletAddress: row.userWalletAddress,
    incomingTxHash: row.incomingTxHash,
    incomingUsdcAmount: row.incomingUsdcAmount.toString(),
    serviceFeeUsdcAmount: row.serviceFeeUsdcAmount.toString(),
    swapInputUsdcAmount: row.swapInputUsdcAmount.toString(),
    swapTxHash: row.swapTxHash ?? undefined,
    swapInputUsdceAmount: row.swapInputUsdceAmount?.toString(),
    swapOutputW0gAmount: row.swapOutputW0gAmount?.toString(),
    swapGasCostWei: row.swapGasCostWei?.toString(),
    unwrapTxHash: row.unwrapTxHash ?? undefined,
    unwrapGasCostWei: row.unwrapGasCostWei?.toString(),
    unwrappedOgAmount: row.unwrappedOgAmount?.toString(),
    sendTxHash: row.sendTxHash ?? undefined,
    sendGasCostWei: row.sendGasCostWei?.toString(),
    ogAmountSentToUser: row.ogAmountSentToUser?.toString(),
    ledgerTopUpTxHash: row.ledgerTopUpTxHash ?? undefined,
    ledgerTopUpGasCostWei: row.ledgerTopUpGasCostWei?.toString(),
    status: row.status as ZeroGPurchaseStatus,
    errorMessage: row.errorMessage ?? undefined,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaZeroGPurchaseRepository implements ZeroGPurchaseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(purchase: ZeroGPurchase): Promise<void> {
    await this.prisma.zeroGPurchase.create({
      data: {
        id: purchase.id,
        userId: purchase.userId,
        userWalletAddress: purchase.userWalletAddress,
        incomingTxHash: purchase.incomingTxHash,
        incomingUsdcAmount: BigInt(purchase.incomingUsdcAmount),
        serviceFeeUsdcAmount: BigInt(purchase.serviceFeeUsdcAmount),
        swapInputUsdcAmount: BigInt(purchase.swapInputUsdcAmount),
        status: purchase.status,
        createdAt: BigInt(purchase.createdAt),
        updatedAt: BigInt(purchase.updatedAt),
      },
    });
  }

  async findById(id: string): Promise<ZeroGPurchase | null> {
    const row = await this.prisma.zeroGPurchase.findUnique({ where: { id } });
    return row ? rowToDomain(row) : null;
  }

  async findByIncomingTxHash(txHash: string): Promise<ZeroGPurchase | null> {
    const row = await this.prisma.zeroGPurchase.findUnique({ where: { incomingTxHash: txHash } });
    return row ? rowToDomain(row) : null;
  }

  async listByUser(userId: string, filter?: { statuses?: ZeroGPurchaseStatus[] }): Promise<ZeroGPurchase[]> {
    const where: Record<string, unknown> = { userId };
    if (filter?.statuses && filter.statuses.length > 0) {
      where.status = { in: filter.statuses };
    }
    const rows = await this.prisma.zeroGPurchase.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(rowToDomain);
  }

  async update(id: string, patch: Partial<Omit<ZeroGPurchase, 'id' | 'userId' | 'createdAt'>>): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: BigInt(Date.now()) };
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.errorMessage !== undefined) data.errorMessage = patch.errorMessage;
    if (patch.swapTxHash !== undefined) data.swapTxHash = patch.swapTxHash;
    if (patch.swapInputUsdceAmount !== undefined) data.swapInputUsdceAmount = BigInt(patch.swapInputUsdceAmount);
    if (patch.swapOutputW0gAmount !== undefined) data.swapOutputW0gAmount = BigInt(patch.swapOutputW0gAmount);
    if (patch.swapGasCostWei !== undefined) data.swapGasCostWei = BigInt(patch.swapGasCostWei);
    if (patch.unwrapTxHash !== undefined) data.unwrapTxHash = patch.unwrapTxHash;
    if (patch.unwrapGasCostWei !== undefined) data.unwrapGasCostWei = BigInt(patch.unwrapGasCostWei);
    if (patch.unwrappedOgAmount !== undefined) data.unwrappedOgAmount = BigInt(patch.unwrappedOgAmount);
    if (patch.sendTxHash !== undefined) data.sendTxHash = patch.sendTxHash;
    if (patch.sendGasCostWei !== undefined) data.sendGasCostWei = BigInt(patch.sendGasCostWei);
    if (patch.ogAmountSentToUser !== undefined) data.ogAmountSentToUser = BigInt(patch.ogAmountSentToUser);
    if (patch.ledgerTopUpTxHash !== undefined) data.ledgerTopUpTxHash = patch.ledgerTopUpTxHash;
    if (patch.ledgerTopUpGasCostWei !== undefined) data.ledgerTopUpGasCostWei = BigInt(patch.ledgerTopUpGasCostWei);
    await this.prisma.zeroGPurchase.update({ where: { id }, data });
  }
}
