import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { signalStore, withMethods, withState, patchState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type AccountView, type AccountLevel, type CreateAccountInput } from '@hala/shared';

interface MemberVm { _id: string; userId: string; level: AccountLevel }
interface QrView { accountId: string; image: string }

export const AccountsStore = signalStore(
  { providedIn: 'root' },
  withState<{ accounts: AccountView[]; members: MemberVm[]; selectedId: string | null; qr: QrView | null; loading: boolean }>({
    accounts: [], members: [], selectedId: null, qr: null, loading: false
  }),
  withMethods((store, http = inject(HttpClient)) => ({
    async load(): Promise<void> {
      patchState(store, { loading: true });
      try { patchState(store, { accounts: await firstValueFrom(http.get<AccountView[]>('/api/v1/whatsapp/accounts')) }); }
      finally { patchState(store, { loading: false }); }
    },
    async create(input: CreateAccountInput): Promise<void> {
      await firstValueFrom(http.post('/api/v1/whatsapp/accounts', input));
      patchState(store, { accounts: await firstValueFrom(http.get<AccountView[]>('/api/v1/whatsapp/accounts')) });
    },
    async update(id: string, input: { label: string }): Promise<void> {
      await firstValueFrom(http.patch(`/api/v1/whatsapp/accounts/${id}`, input));
      patchState(store, { accounts: await firstValueFrom(http.get<AccountView[]>('/api/v1/whatsapp/accounts')) });
    },
    async operation(id: string, kind: 'connect' | 'disconnect' | 'logout'): Promise<void> {
      const account = await firstValueFrom(http.post<AccountView>(`/api/v1/whatsapp/accounts/${id}/${kind}`, {}));
      patchState(store, { accounts: store.accounts().map(current => current._id === id ? account : current) });
    },
    async getQr(id: string): Promise<string | null> {
      try {
        const res = await firstValueFrom(http.get<{ qr: string | null }>(`/api/v1/whatsapp/accounts/${id}/qr`));
        if (res.qr) {
          const QRCode = (await import('qrcode')).default;
          const image = await QRCode.toDataURL(res.qr);
          patchState(store, { qr: { accountId: id, image } });
          return image;
        }
      } catch {
        // endpoint may be temporarily unavailable
      }
      return null;
    },
    async syncHistory(id: string): Promise<void> {
      await firstValueFrom(http.post(`/api/v1/whatsapp/accounts/${id}/sync-history`, {}));
    },
    async clearChats(id: string): Promise<void> {
      await firstValueFrom(http.delete(`/api/v1/whatsapp/accounts/${id}/chats`, { body: { confirm: true } }));
      patchState(store, { accounts: await firstValueFrom(http.get<AccountView[]>('/api/v1/whatsapp/accounts')) });
    },
    async remove(id: string): Promise<void> {
      await firstValueFrom(http.delete(`/api/v1/whatsapp/accounts/${id}`));
      patchState(store, { accounts: store.accounts().filter(account => account._id !== id) });
    },
    async select(id: string): Promise<void> {
      patchState(store, { selectedId: id, members: [] });
      patchState(store, { members: await firstValueFrom(http.get<MemberVm[]>(`/api/v1/whatsapp/accounts/${id}/members`)) });
    },
    async setMember(id: string, userId: string, level: AccountLevel): Promise<void> {
      await firstValueFrom(http.put(`/api/v1/whatsapp/accounts/${id}/members/${userId}`, { level }));
      patchState(store, { members: await firstValueFrom(http.get<MemberVm[]>(`/api/v1/whatsapp/accounts/${id}/members`)) });
    },
    async removeMember(id: string, userId: string): Promise<void> {
      await firstValueFrom(http.delete(`/api/v1/whatsapp/accounts/${id}/members/${userId}`));
      patchState(store, { members: store.members().filter(member => member.userId !== userId) });
    },
    applyStatus(event: { accountId: string; status: AccountView['status']; phoneNumber?: string }): void {
      patchState(store, { accounts: store.accounts().map(account => account._id === event.accountId
        ? { ...account, status: event.status, phoneNumber: event.phoneNumber ?? account.phoneNumber } : account) });
    },
    showQr(qr: QrView): void { patchState(store, { qr }); },
    closeQr(): void { patchState(store, { qr: null }); },
    clear(): void { patchState(store, { accounts: [], members: [], selectedId: null, qr: null }); }
  }))
);
