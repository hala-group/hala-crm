import { Module } from '@nestjs/common';
import { CloudWebhookController } from './cloud-webhook.controller.js';

@Module({ controllers: [CloudWebhookController] })
export class CloudWebhookModule {}
