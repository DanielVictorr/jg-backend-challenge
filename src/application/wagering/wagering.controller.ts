
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';

import {
  ProcessWagerTransaction,
} from './process-wager-transaction.js';

import type {
  ProcessWagerTransactionInput,
} from './process-wager-transaction.js';

type ProcessWagerRequestBody = Omit<
  ProcessWagerTransactionInput,
  'idempotencyKey'
>;

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
  ) {}

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
