import { describe, expect, it } from 'vitest';
import { ProviderAuthenticationGuard } from './provider-authentication.guard.js';

describe('ProviderAuthenticationGuard', () => {
    it('permite requisições enquanto a autenticação externa não estiver configurada', () => {
        expect(new ProviderAuthenticationGuard().canActivate()).toBe(true);
    });
});
