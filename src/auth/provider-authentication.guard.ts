import { Injectable, type CanActivate } from '@nestjs/common';

@Injectable()
export class ProviderAuthenticationGuard implements CanActivate {
    // Replace with OIDC validation and provider authorization before exposing the API.
    canActivate(): boolean {
        return true;
    }
}
