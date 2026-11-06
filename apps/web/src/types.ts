export type Row = { id: string; name: string; notes: string | null };
export type Property = Row & { address: string | null };
export type Room = Row & { propertyId: string; property: { name: string }; suggestedPaise: number | null; suggestedDay: number | null; archivedAt: string | null; leases: { id: string; tenant: { id: string; name: string }; terms: { amountPaise: number; dueDay: number }[] }[] };
export type Tenant = Row & { phone: string | null; whatsapp: string | null; email: string | null; archivedAt: string | null; consentAt: string | null; optedOutAt: string | null; consentSource: string | null };
export type Lease = { id: string; roomId: string; tenantId: string; startsOn: string; endsOn: string | null; depositPaise: number | null; room: { name: string }; tenant: { name: string }; terms: { id: string; period: string; amountPaise: number; dueDay: number }[] };
export type Charge = { id: string; leaseId: string; month: string; dueOn: string; amountPaise: number; allocatedPaise: number; outstandingPaise: number; overdue: boolean; status: string; tenant: string; room: string; property: string };
export type Notice = { id: string; paymentId: string; status: string; reason: string | null; retryable: boolean; manualRetries: number; attempts: number; createdAt: string };
export type Payment = { id: string; leaseId: string; paidAt: string; amountPaise: number; mode: 'CASH' | 'ONLINE'; reference: string | null; source: string; reversal: { createdAt: string } | null; notification: { id: string; status: string } | null; lease: { tenant: { name: string }; room: { name: string; property: { name: string } } } };
export type PaymentDetails = Pick<Payment, 'id' | 'leaseId' | 'paidAt' | 'amountPaise' | 'mode' | 'reference' | 'source'> & {
  notes: string | null; creditPaise: number; reversal: { createdAt: string; reason: string } | null;
  allocations: { id: string; amountPaise: number; charge: { period: string } }[];
  notification: { status: string; snapshot: { tenant: string; owner: string; property: string; room: string } } | null;
};
export type Summary = { expected: string; applied: string; outstanding: string; overdue: string; received: string; rooms: number; occupied: number; vacant: number; activeTenants: number;
  cashModes: { mode: string; amount: string }[]; notices: { status: string; _count: { _all: number } }[]; upcoming: Charge[]; recentPayments: Payment[];
  byRoom: { property: string; room: string; roomId: string; amount: string; outstanding: string }[]; trend: { month: string; expected: string; applied: string }[];
};
