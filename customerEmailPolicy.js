// Customer email is optional. Admin OTP email authentication is separate.
export function validOptionalCustomerEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return email === '' || (
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}
