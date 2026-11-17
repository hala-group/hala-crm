import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { tenantSchema } from './tenants/tenant.schema.js';
import { userSchema } from './users/user.schema.js';
import { roleSchema } from './roles/role.schema.js';
import { auditSchema } from './audit/audit.schema.js';
import { invitationSchema, refreshSessionSchema } from './auth/auth.schema.js';
import { accountSchema, accountMemberSchema, waAuthStateSchema } from './whatsapp-accounts/account.schema.js';
import { contactSchema, contactAvatarSchema, conversationSchema, messageSchema, mediaSchema } from './inbox/inbox.schema.js';
import { callSchema } from './calls/call.schema.js';
import { callPushSubscriptionSchema } from './calls/call-push.schema.js';

export const modelDefinitions = [
  { name: 'Tenant', schema: tenantSchema },
  { name: 'User', schema: userSchema },
  { name: 'Role', schema: roleSchema },
  { name: 'AuditLog', schema: auditSchema },
  { name: 'Invitation', schema: invitationSchema },
  { name: 'RefreshSession', schema: refreshSessionSchema },
  { name: 'WhatsAppAccount', schema: accountSchema },
  { name: 'AccountMember', schema: accountMemberSchema },
  { name: 'WaAuthState', schema: waAuthStateSchema },
  { name: 'Contact', schema: contactSchema },
  { name: 'ContactAvatar', schema: contactAvatarSchema },
  { name: 'Conversation', schema: conversationSchema },
  { name: 'Message', schema: messageSchema },
  { name: 'Media', schema: mediaSchema },
  { name: 'Call', schema: callSchema },
  { name: 'CallPushSubscription', schema: callPushSubscriptionSchema }
];

@Module({
  imports: [MongooseModule.forFeature(modelDefinitions)],
  exports: [MongooseModule]
})
export class PersistenceModule {}
