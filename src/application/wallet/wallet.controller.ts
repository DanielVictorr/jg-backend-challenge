import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { CreateWallet } from './create-wallet.js';
import type { CreateWalletInput } from './create-wallet.js';
import { GetWallet } from './get-wallet.js';
import { GetWalletLedger } from './get-wallet-ledger.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getWalletLedger: GetWalletLedger,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletInput) {
    return this.createWallet.execute(body);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', new ParseUUIDPipe({ version: '4' }))
    walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    if (limit !== undefined && !/^\d+$/.test(limit)) {
      throw new BadRequestException({
        code: 'INVALID_LEDGER_LIMIT',
        message: 'O limite deve ser um inteiro entre 1 e 100.',
      });
    }

    return this.getWalletLedger.execute(
      walletId,
      cursor,
      limit === undefined ? undefined : Number(limit),
    );
  }

  @Get(':walletId')
  async get(
    @Param('walletId', new ParseUUIDPipe({ version: '4' }))
    walletId: string,
  ) {
    return this.getWallet.execute(walletId);
  }
}
