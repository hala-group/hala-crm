import { ChangeDetectionStrategy, Component } from '@angular/core';
import { httpResource } from '@angular/common/http';

interface AuditVm {
  _id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  at: string;
}

@Component({
  selector: 'hala-audit',
  template: `
    <section class="page">
      <h1>سجل التدقيق</h1>
      @if (logs.isLoading()) { <p>جارٍ التحميل…</p> }
      @else if (logs.error()) { <p class="error">تعذر تحميل السجل.</p> }
      @else {
        <div class="panel">
          @for (entry of logs.value() ?? []; track entry._id) {
            <div class="row"><span>{{ entry.action }} · {{ entry.resourceType }} · {{ entry.resourceId }}</span><time>{{ entry.at }}</time></div>
          } @empty { <p>لا توجد أحداث بعد.</p> }
        </div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AuditComponent {
  readonly logs = httpResource<AuditVm[]>(() => '/api/v1/audit-logs');
}
