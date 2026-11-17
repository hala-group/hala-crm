import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { defineAbilityFor } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { type AccountAccessService } from '../access/account-access.service.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { CallsService } from './calls.service.js';
import { type CallRecord } from './call.schema.js';

describe('CallsService', () => {
  it('rechecks a call against the current role and account access before realtime delivery', async () => {
    const tenantId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const callId = new Types.ObjectId().toString();
    const user = { _id: new Types.ObjectId(userId), tenantId: new Types.ObjectId(tenantId), roleId: new Types.ObjectId() };
    const role = { permissions: ['calls:read'] };
    const calls = { exists: vi.fn().mockResolvedValue(true) };
    const users = { findById: vi.fn(() => ({ lean: async () => user })) };
    const roles = { findById: vi.fn(() => ({ lean: async () => role })) };
    const access = { resolve: vi.fn().mockResolvedValue({ all: false, accounts: new Map([['account-1', 'view']]) }) };
    const service = new CallsService(
      calls as unknown as Model<CallRecord>, users as unknown as Model<UserRecord>,
      roles as unknown as Model<RoleRecord>, access as unknown as AccountAccessService
    );

    expect(await service.canReadForUser(tenantId, userId, callId)).toBe(true);
    expect(access.resolve).toHaveBeenCalledWith(tenantId, userId, ['calls:read']);
    expect(calls.exists).toHaveBeenCalledOnce();
    const filter = calls.exists.mock.calls[0][0] as { $and: Record<string, unknown>[] };
    expect(filter.$and[0]).toEqual({ _id: callId });
    expect(filter.$and[1]).toEqual({
      $or: expect.arrayContaining([expect.objectContaining({ accountId: { $in: ['account-1'] }, tenantId })])
    });
  });

  it('lists calls through the caller ability and applies the server limit', async () => {
    const tenantId = new Types.ObjectId().toString();
    const accountId = new Types.ObjectId().toString();
    const call = { _id: new Types.ObjectId(), accountId: new Types.ObjectId(accountId) };
    const query = {
      sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([call])
    };
    const calls = { find: vi.fn(() => query) };
    const ability = defineAbilityFor({ id: 'user-1', tenantId }, { permissions: ['calls:read'] }, [
      { accountId, level: 'view' }
    ]);
    const principal = { ability } as Principal;
    const service = new CallsService(
      calls as unknown as Model<CallRecord>, {} as Model<UserRecord>, {} as Model<RoleRecord>,
      {} as AccountAccessService
    );

    expect(await service.list(principal)).toEqual([call]);
    expect(calls.find).toHaveBeenCalledOnce();
    const filter = calls.find.mock.calls[0][0] as { $and: Record<string, unknown>[] };
    expect(filter.$and[0]).toEqual({
      $or: expect.arrayContaining([expect.objectContaining({ accountId: { $in: [accountId] }, tenantId })])
    });
    expect(query.sort).toHaveBeenCalledWith({ startedAt: -1 });
    expect(query.limit).toHaveBeenCalledWith(100);
  });

  it('enriches calls with contact, account, and conversation details when models are available', async () => {
    const tenantId = new Types.ObjectId().toString();
    const accountId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const convId = new Types.ObjectId();
    const call = {
      _id: new Types.ObjectId(),
      accountId,
      contactId,
      direction: 'in',
      isVideo: false,
      status: 'missed',
      startedAt: new Date('2026-11-14T10:00:00.000Z')
    };
    const calls = { find: vi.fn(() => ({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([call]) })) };
    const contacts = { find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: contactId, displayName: 'Ahmed Ali', phoneE164: '+96891234567' }]) })) };
    const accounts = { find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: accountId, label: 'Sales Line', phoneNumber: '+96890000000' }]) })) };
    const conversations = {
      find: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([{ _id: convId, accountId, contactId }])
      }))
    };
    const ability = defineAbilityFor({ id: 'user-1', tenantId }, { permissions: ['calls:read'] }, [
      { accountId: accountId.toString(), level: 'view' }
    ]);
    const principal = { ability } as Principal;
    const service = new CallsService(
      calls as unknown as Model<CallRecord>, {} as Model<UserRecord>, {} as Model<RoleRecord>,
      {} as AccountAccessService, contacts as any, accounts as any, conversations as any
    );

    const result = await service.list(principal);
    expect(result).toHaveLength(1);
    expect(result[0].contact?.displayName).toBe('Ahmed Ali');
    expect(result[0].account?.label).toBe('Sales Line');
    expect(result[0].conversationId).toBe(convId.toString());
  });
});
