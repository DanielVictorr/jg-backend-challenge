import {
  Controller,
  Get,
  Param,
} from '@nestjs/common';

import { GetWagerTransaction } from './get-wager-transaction.js';

@Controller('providers')
export class ProviderWageringTransactionsController {
  constructor(
    private readonly getWagerTransaction: GetWagerTransaction,
  ) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getWagerTransaction.executeByExternalId(
      providerId,
      externalTransactionId,
    );
  }
}