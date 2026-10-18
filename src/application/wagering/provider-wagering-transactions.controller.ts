import { Controller, Get, Param, UseGuards, } from '@nestjs/common';
import { GetWagerTransaction } from './get-wager-transaction.js';
import { ProviderAuthenticationGuard } from '../../auth/provider-authentication.guard.js';
@UseGuards(ProviderAuthenticationGuard)
@Controller('providers')
export class ProviderWageringTransactionsController {
    constructor(private readonly getWagerTransaction: GetWagerTransaction) { }
    @Get(':providerId/wagering/transactions/:externalTransactionId')
    getByExternalId(
    @Param('providerId')
    providerId: string, 
    @Param('externalTransactionId')
    externalTransactionId: string) {
        return this.getWagerTransaction.executeByExternalId(providerId, externalTransactionId);
    }
}
