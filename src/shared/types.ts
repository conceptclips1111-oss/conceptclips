export type User = { id: string; phone: string; email: string; name: string; role: 'customer' | 'admin' };
export type Product = { id: string; title: string; subject: string; description: string; overview: string; price: number; pages: number; level: string; color: string; published: boolean; file_key: string | null; updated_at: string };
export type PublicProduct = Omit<Product, 'file_key'> & { has_pdf: boolean };
export type Settings = { store_name: string; upi_id: string; payee_name: string; payments_enabled: boolean; support_email: string };
export type OrderStatus = 'awaiting_payment' | 'pending' | 'approved' | 'rejected';
export type Order = { id: string; user_id: string; product_id: string; amount: number; status: OrderStatus; transaction_id: string | null; payer_name: string | null; paid_at: string | null; note: string | null; rejection_reason: string | null; created_at: string; submitted_at: string | null; reviewed_at: string | null; reviewed_by: string | null; payee_name: string; upi_id: string; is_demo: boolean };
export type OrderView = Order & { product_title: string; subject: string; customer_name: string; customer_phone: string; customer_email: string };
export type Submission = { transaction_id: string; payer_name: string; paid_at: string; note: string };
export const formatMoney = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
