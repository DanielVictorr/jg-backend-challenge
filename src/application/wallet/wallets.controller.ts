
import { Body, Controller, Post } from '@nestjs/common';
import { CreateWallet } from './create-wallet.js';
import type { CreateWalletInput } from './create-wallet.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWallet) {}

  @Post()
  async create(@Body() body: CreateWalletInput) {
    return this.createWallet.execute(body);
  }
}
