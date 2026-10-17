
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

import { GetWallet } from './get-wallet.js';
import { WalletEntity } from '../../database/entities/wallet.entity.js';

describe('GetWallet', () => {
  const walletRepository = {
    findOne: vi.fn(),
  };

  const dataSource = {
    getRepository: vi.fn(() => walletRepository),
  } as unknown as DataSource;

  const useCase = new GetWallet(dataSource);

  const wallet: WalletEntity = {
    id: '7b3d0e9a-9a1f-4a6a-8c1a-123456789abc',
    playerId: 'player-001',
    currency: 'BRL',
    balance: '1250.75',
    version: 2,
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    updatedAt: new Date('2026-01-02T10:00:00.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the wallet and preserves the decimal balance as a string', async () => {
    walletRepository.findOne.mockResolvedValue(wallet);

    const result = await useCase.execute(wallet.id);

    expect(result).toEqual({
      id: wallet.id,
      playerId: 'player-001',
      balance: {
        amount: '1250.75',
        currency: 'BRL',
      },
      version: 2,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    expect(typeof result.balance.amount).toBe('string');
    expect(walletRepository.findOne).toHaveBeenCalledWith({
      where: { id: wallet.id },
    });
  });

  it('throws WALLET_NOT_FOUND when the wallet does not exist', async () => {
    walletRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute(wallet.id),
    ).rejects.toMatchObject({
      response: {
        code: 'WALLET_NOT_FOUND',
      },
      status: 404,
    });
  });
});
