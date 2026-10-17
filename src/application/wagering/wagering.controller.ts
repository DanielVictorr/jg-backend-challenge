import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { ProcessWagerTransaction } from './process-wager-transaction.js';
import { GetWagerTransaction } from './get-wager-transaction.js';

import type { ProcessWagerTransactionInput } from './process-wager-transaction.js';

type ProcessWagerRequestBody = Omit<
  ProcessWagerTransactionInput,
  'idempotencyKey'
>;

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly getWagerTransaction: GetWagerTransaction,
  ) {}

  @Get('transactions/:transactionId')
  getById(
    @Param('transactionId', new ParseUUIDPipe({ version: 'all' }))
    transactionId: string,
  ) {
    return this.getWagerTransaction.executeById(transactionId);
  }

  @Post('transactions')
  async process(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: ProcessWagerRequestBody,
  ) {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim().length === 0
    ) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'O cabeçalho Idempotency-Key é obrigatório.',
      });
    }

    return this.processWagerTransaction.execute({
      ...body,
      idempotencyKey,
    });
  }
}
