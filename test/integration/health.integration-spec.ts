import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
describe('Health — integração HTTP', () => {
    let app: INestApplication;
    beforeAll(async () => {
        if (process.env.DB_DATABASE !== 'jg_backend_integration' ||
            process.env.DB_PORT !== '55432') {
            throw new Error('Teste bloqueado: configure o banco jg_backend_integration na porta 55432.');
        }
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
    });
    afterAll(async () => {
        if (app) {
            await app.close();
        }
    });
    it('deve responder no endpoint de liveness sem autenticação', async () => {
        const response = await request(app.getHttpServer())
            .get('/health/live')
            .expect(200);
        expect(response.body).toEqual({
            status: 'ok',
        });
    });
    it('deve confirmar PostgreSQL e SQS no endpoint de readiness', async () => {
        const response = await request(app.getHttpServer())
            .get('/health/ready')
            .expect(200);
        expect(response.body).toEqual({
            status: 'ok',
            checks: {
                postgres: 'ok',
                sqs: 'ok',
            },
        });
    });
});
