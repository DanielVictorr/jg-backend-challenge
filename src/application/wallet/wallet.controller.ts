import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { CreateWallet } from './create-wallet.js';
import type { CreateWalletInput } from './create-wallet.js';
import { GetWallet } from './get-wallet.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletInput) {
    return this.createWallet.execute(body);
  }

  @Get(':walletId')
  async get(
    @Param('walletId', new ParseUUIDPipe({ version: '4' }))
    walletId: string,
  ) {
    return this.getWallet.execute(walletId);
  }
}
