// Stand-in application code. The E2E run pretends to change this file so the
// workflow has something concrete to talk about.

export function totalOrderValue(order) {
  return order.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}

export function canCancel(order, actor) {
  return order.status === 'DRAFT' && actor.permissions.includes('orders:cancel');
}
