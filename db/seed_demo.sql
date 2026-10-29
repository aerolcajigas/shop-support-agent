-- Demo data (fake people). Dates are relative to now() so the return-window cases stay true.
insert into shop.customers (email, name) values
  ('dana@example.com', 'Dana Reyes'),
  ('sam@example.com', 'Sam Lee');

insert into shop.orders (number, customer_id, status, placed_at, delivered_at, total, carrier, tracking_number, tracking_url) values
  ('1042', 1, 'delivered', now() - interval '12 days', now() - interval '8 days', 129.00, 'UPS', '1Z999AA10123456784', 'https://www.ups.com/track?tracknum=1Z999AA10123456784'),
  ('1043', 1, 'fulfilled', now() - interval '3 days', null, 54.00, 'USPS', '9400100000000000000000', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000'),
  ('1001', 1, 'delivered', now() - interval '70 days', now() - interval '64 days', 89.00, 'UPS', '1Z999AA10123456700', null),
  ('1050', 2, 'delivered', now() - interval '6 days', now() - interval '2 days', 40.00, null, null, null),
  ('1051', 2, 'paid', now() - interval '1 day', null, 310.00, null, null, null);

insert into shop.order_items (order_id, sku, title, qty, price, final_sale) values
  (1, 'POUR-SAND', 'Ceramic Pour-Over Set (Sand)', 1, 89.00, false),
  (1, 'FILT-100', 'Paper Filters (100)', 2, 20.00, false),
  (2, 'BEAN-ETH', 'Ethiopia Whole Bean 12oz', 3, 18.00, false),
  (3, 'MUG-BLK', 'Stoneware Mug (Black)', 1, 89.00, false),
  (4, 'GIFT-BOX', 'Holiday Gift Box', 1, 40.00, true),
  (5, 'GRIND-PRO', 'Burr Grinder Pro', 1, 310.00, false);
