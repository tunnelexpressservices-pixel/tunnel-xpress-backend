import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../lib/asyncHandler';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { initPaymentSchema, verifyPaymentSchema } from '../schemas';
import { config } from '../config';
import { emitToRiders, notifyRidersOfNewDelivery } from '../socket';

const router = Router();

// Fake mode: when no Paystack secret key is configured (or the value looks
// like a placeholder), simulate successful payments end-to-end so the rest
// of the flow can be tested without keys.
const PAYSTACK_KEY = (config.paystack.secretKey || '').trim();
const FAKE_PAYMENTS =
  !PAYSTACK_KEY ||
  PAYSTACK_KEY.includes('xxx') ||
  PAYSTACK_KEY.toLowerCase() === 'sk_test_' ||
  PAYSTACK_KEY.length < 20;
if (FAKE_PAYMENTS) {
  // eslint-disable-next-line no-console
  console.warn('[payments] PAYSTACK_SECRET_KEY missing or placeholder — running in FAKE payment mode (all payments auto-succeed).');
}

router.use(authenticate);

/** Paid order → rider pool: FINDING_RIDER + notify riders. Idempotent per call site. */
async function releaseToRiders(deliveryId: string) {
  const finding = await prisma.delivery.update({
    where: { id: deliveryId },
    data: { status: 'FINDING_RIDER', paidAt: new Date() },
    select: { id: true, orderTag: true, pickupAddress: true, dropoffAddress: true, totalFee: true, distanceKm: true, packageName: true, riderType: true },
  });
  emitToRiders('rider:newDelivery', finding);
  notifyRidersOfNewDelivery(finding.id).catch(() => {});
}

// ─── INITIALIZE PAYMENT ─────────────────────────────────

router.post(
  '/initialize',
  validate(initPaymentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { deliveryId, method, savedCardId } = req.body;

    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) throw new AppError('Delivery not found', 404);
    if (delivery.customerId !== req.user!.userId) {
      throw new AppError('Not authorized', 403);
    }
    if (delivery.status !== 'PENDING_PAYMENT') {
      throw new AppError('Delivery is not awaiting payment', 400);
    }

    // Check for existing pending payment
    const existingPayment = await prisma.payment.findUnique({
      where: { deliveryId },
    });
    if (existingPayment && existingPayment.status === 'SUCCESS') {
      throw new AppError('Payment already completed', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { email: true },
    });

    const reference = `TXN_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // ─── WALLET / COUPON ────────────────────────────────
    // Paid from the user's earned balance — no Paystack involved. The
    // conditional decrement makes a double-tap or race unable to overdraw.
    if (method === 'WALLET') {
      const paid = await prisma.$transaction(async (tx) => {
        const debit = await tx.wallet.updateMany({
          where: { userId: req.user!.userId, balance: { gte: delivery.totalFee } },
          data: { balance: { decrement: delivery.totalFee } },
        });
        if (debit.count === 0) return null;
        return tx.payment.upsert({
          where: { deliveryId },
          update: { amount: delivery.totalFee, method, status: 'SUCCESS', paystackRef: reference },
          create: { deliveryId, userId: req.user!.userId, amount: delivery.totalFee, method, status: 'SUCCESS', paystackRef: reference },
        });
      });
      if (!paid) throw new AppError('Your coupon balance is not enough for this delivery. Please choose another payment method.', 400);
      await releaseToRiders(deliveryId);
      return res.json({ success: true, data: { payment: paid, requiresAction: false, reference } });
    }

    // ─── FAKE MODE ──────────────────────────────────────
    // No Paystack key configured: pretend the charge succeeded immediately.
    if (FAKE_PAYMENTS) {
      const payment = await prisma.payment.upsert({
        where: { deliveryId },
        update: {
          amount: delivery.totalFee,
          method,
          status: 'SUCCESS',
          paystackRef: reference,
        },
        create: {
          deliveryId,
          userId: req.user!.userId,
          amount: delivery.totalFee,
          method,
          status: 'SUCCESS',
          paystackRef: reference,
        },
      });

      // Mark as paid and awaiting a rider. The rider app drives the rest of
      // the lifecycle (accept → picked up → in transit → delivered).
      const finding = await prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'FINDING_RIDER', paidAt: new Date() },
        select: { id: true, orderTag: true, pickupAddress: true, dropoffAddress: true, totalFee: true, distanceKm: true, packageName: true, riderType: true },
      });
      emitToRiders('rider:newDelivery', finding);
      notifyRidersOfNewDelivery(finding.id).catch(() => {});

      return res.json({
        success: true,
        data: {
          payment,
          requiresAction: false,
          reference,
          fake: true,
        },
      });
    }

    // If using saved card with authorization code
    if (savedCardId && method === 'CARD') {
      const savedCard = await prisma.savedCard.findFirst({
        where: { id: savedCardId, userId: req.user!.userId },
      });

      if (!savedCard) throw new AppError('Saved card not found', 404);

      // Charge the authorization
      const chargeResponse = await chargeAuthorization(
        savedCard.authCode,
        user!.email!,
        delivery.totalFee * 100, // Paystack uses kobo
        reference
      );

      const payment = await prisma.payment.upsert({
        where: { deliveryId },
        update: {
          amount: delivery.totalFee,
          method,
          status: chargeResponse.success ? 'SUCCESS' : 'FAILED',
          paystackRef: reference,
          paystackAuthCode: savedCard.authCode,
        },
        create: {
          deliveryId,
          userId: req.user!.userId,
          amount: delivery.totalFee,
          method,
          status: chargeResponse.success ? 'SUCCESS' : 'FAILED',
          paystackRef: reference,
          paystackAuthCode: savedCard.authCode,
        },
      });

      if (chargeResponse.success) {
        await prisma.delivery.update({
          where: { id: deliveryId },
          data: { status: 'FINDING_RIDER', paidAt: new Date() },
        });
        emitToRiders('rider:newDelivery', { deliveryId });
        notifyRidersOfNewDelivery(deliveryId).catch(() => {});
      }

      return res.json({
        success: chargeResponse.success,
        data: {
          payment,
          requiresAction: false,
        },
      });
    }

    // ─── BANK TRANSFER / OPAY ───────────────────────────
    // Paystack issues a one-time account number for this exact amount; the app
    // shows it and polls /verify (the webhook also completes it if the user
    // leaves). Opay users pay the same way, from their Opay app.
    if (method === 'BANK_TRANSFER' || method === 'OPAY') {
      const charge = await chargeBankTransfer(
        user!.email!,
        delivery.totalFee * 100,
        reference,
        { deliveryId, userId: req.user!.userId },
      );
      const payment = await prisma.payment.upsert({
        where: { deliveryId },
        update: { amount: delivery.totalFee, method, paystackRef: reference, status: 'PENDING' },
        create: { deliveryId, userId: req.user!.userId, amount: delivery.totalFee, method, paystackRef: reference },
      });
      return res.json({
        success: true,
        data: {
          payment,
          requiresAction: true,
          reference,
          transfer: {
            bankName: charge.bank?.name,
            accountNumber: charge.account_number,
            accountName: charge.account_name,
            amount: delivery.totalFee,
            expiresAt: charge.account_expires_at,
          },
        },
      });
    }

    // Initialize new Paystack transaction (hosted checkout). All channels stay
    // enabled: app builds ≤1.1.2 send every payment as CARD, and their users
    // still need transfer/USSD on this page.
    const initResponse = await initializePaystackTransaction(
      user!.email!,
      delivery.totalFee * 100,
      reference,
      { deliveryId, userId: req.user!.userId },
    );

    const payment = await prisma.payment.upsert({
      where: { deliveryId },
      update: {
        amount: delivery.totalFee,
        method,
        paystackRef: reference,
        status: 'PENDING',
      },
      create: {
        deliveryId,
        userId: req.user!.userId,
        amount: delivery.totalFee,
        method,
        paystackRef: reference,
      },
    });

    res.json({
      success: true,
      data: {
        payment,
        requiresAction: true,
        authorizationUrl: initResponse.authorization_url,
        accessCode: initResponse.access_code,
        reference,
      },
    });
  })
);

// ─── VERIFY PAYMENT ─────────────────────────────────────

router.post(
  '/verify',
  validate(verifyPaymentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { reference } = req.body;

    const payment = await prisma.payment.findUnique({
      where: { paystackRef: reference },
    });

    if (!payment) throw new AppError('Payment not found', 404);
    if (payment.userId !== req.user!.userId) {
      throw new AppError('Not authorized', 403);
    }

    // Already settled (e.g. the webhook confirmed a transfer first): report it
    // without touching the delivery — a rider may already have accepted it.
    if (payment.status === 'SUCCESS') {
      return res.json({
        success: true,
        message: 'Payment verified successfully',
        data: { status: 'SUCCESS', deliveryId: payment.deliveryId },
      });
    }

    // ─── FAKE MODE ──────────────────────────────────────
    if (FAKE_PAYMENTS) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'SUCCESS' },
      });
      await releaseToRiders(payment.deliveryId);
      return res.json({
        success: true,
        message: 'Payment verified successfully (fake mode)',
        data: { status: 'SUCCESS', deliveryId: payment.deliveryId },
      });
    }

    // Verify with Paystack
    const verification = await verifyPaystackTransaction(reference);

    if (verification.status === 'success') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCESS',
          paystackAuthCode: verification.authorization?.authorization_code,
        },
      });

      // Same lifecycle as fake mode: paid orders go straight to the rider pool.
      const finding = await prisma.delivery.update({
        where: { id: payment.deliveryId },
        data: { status: 'FINDING_RIDER', paidAt: new Date() },
        select: { id: true, orderTag: true, pickupAddress: true, dropoffAddress: true, totalFee: true, distanceKm: true, packageName: true, riderType: true },
      });
      emitToRiders('rider:newDelivery', finding);
      notifyRidersOfNewDelivery(finding.id).catch(() => {});

      // Save card if reusable
      if (verification.authorization?.reusable && verification.authorization?.authorization_code) {
        const auth = verification.authorization;
        const existing = await prisma.savedCard.findFirst({
          where: {
            userId: payment.userId,
            last4: auth.last4,
            brand: auth.brand || auth.card_type,
          },
        });

        if (!existing) {
          await prisma.savedCard.create({
            data: {
              userId: payment.userId,
              last4: auth.last4,
              brand: auth.brand || auth.card_type,
              expMonth: parseInt(auth.exp_month, 10),
              expYear: parseInt(auth.exp_year, 10),
              authCode: auth.authorization_code,
              bank: auth.bank,
            },
          });
        }
      }

      return res.json({
        success: true,
        message: 'Payment verified successfully',
        data: { status: 'SUCCESS', deliveryId: payment.deliveryId },
      });
    }

    // Only terminal Paystack statuses are failures. While the user is still on
    // the checkout ('ongoing'/'pending'/'abandoned'), report PENDING so the
    // app keeps polling instead of showing "declined" mid-payment.
    if (verification.status === 'failed' || verification.status === 'reversed') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
      return res.json({
        success: false,
        message: 'Payment failed',
        data: { status: 'FAILED', deliveryId: payment.deliveryId },
      });
    }

    res.json({
      success: true,
      message: 'Payment not completed yet',
      data: { status: 'PENDING', deliveryId: payment.deliveryId },
    });
  })
);

// ─── GET SAVED CARDS ────────────────────────────────────

router.get(
  '/cards',
  asyncHandler(async (req: Request, res: Response) => {
    const cards = await prisma.savedCard.findMany({
      where: { userId: req.user!.userId },
      select: {
        id: true,
        last4: true,
        brand: true,
        expMonth: true,
        expYear: true,
        isDefault: true,
        bank: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: cards });
  })
);

// ─── DELETE SAVED CARD ──────────────────────────────────

router.delete(
  '/cards/:cardId',
  asyncHandler(async (req: Request, res: Response) => {
    const card = await prisma.savedCard.findFirst({
      where: { id: req.params.cardId as string, userId: req.user!.userId },
    });

    if (!card) throw new AppError('Card not found', 404);

    await prisma.savedCard.delete({ where: { id: card.id } });

    res.json({ success: true, message: 'Card removed' });
  })
);

// ─── SET DEFAULT CARD ───────────────────────────────────

router.patch(
  '/cards/:cardId/default',
  asyncHandler(async (req: Request, res: Response) => {
    // Unset all defaults
    await prisma.savedCard.updateMany({
      where: { userId: req.user!.userId },
      data: { isDefault: false },
    });

    const card = await prisma.savedCard.update({
      where: { id: req.params.cardId as string },
      data: { isDefault: true },
    });

    res.json({ success: true, data: card });
  })
);

// ─── PAYSTACK WEBHOOK ───────────────────────────────────
// Note: This route does NOT use authenticate middleware
// It should be mounted separately in the main app

export async function handlePaystackWebhook(req: Request, res: Response) {
  // Verify webhook signature
  const hash = crypto
    .createHmac('sha512', config.paystack.secretKey)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Invalid signature');
  }

  const event = req.body;

  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const payment = await prisma.payment.findUnique({
      where: { paystackRef: reference },
    });

    if (payment && payment.status !== 'SUCCESS') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'SUCCESS' },
      });

      // Same as /verify: paid orders go straight to the rider pool. Transfers
      // often confirm here after the customer has closed the app.
      await releaseToRiders(payment.deliveryId);
    }
  }

  res.sendStatus(200);
}

// ─── PAYSTACK API HELPERS ───────────────────────────────

async function initializePaystackTransaction(
  email: string,
  amountKobo: number,
  reference: string,
  metadata: Record<string, string>,
  channels?: string[],
) {
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      metadata,
      currency: 'NGN',
      ...(channels ? { channels } : {}),
      // After paying, Paystack sends the user here — a small app page that
      // closes the checkout tab; the original tab's polling completes the flow.
      callback_url: process.env.PAYSTACK_CALLBACK_URL || 'https://tunnel-express.vercel.app/checkout-complete',
    }),
  });

  const data: any = await response.json();
  if (!data.status) throw new AppError('Failed to initialize payment', 502);
  return data.data;
}

async function chargeBankTransfer(
  email: string,
  amountKobo: number,
  reference: string,
  metadata: Record<string, string>,
) {
  const response = await fetch('https://api.paystack.co/charge', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      metadata,
      bank_transfer: { account_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    }),
  });
  const data: any = await response.json();
  if (!data.status || !data.data?.account_number) {
    console.error('[payments] bank transfer charge failed:', response.status, data?.message);
    throw new AppError('Could not set up the bank transfer. Please try again or pay by card.', 502);
  }
  return data.data;
}

async function verifyPaystackTransaction(reference: string) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${config.paystack.secretKey}`,
      },
    }
  );

  const data: any = await response.json();
  if (!data.status) throw new AppError('Payment verification failed', 502);
  return data.data;
}

async function chargeAuthorization(
  authCode: string,
  email: string,
  amountKobo: number,
  reference: string
) {
  const response = await fetch('https://api.paystack.co/transaction/charge_authorization', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      authorization_code: authCode,
      email,
      amount: amountKobo,
      reference,
      currency: 'NGN',
    }),
  });

  const data: any = await response.json();
  return { success: data.data?.status === 'success', data: data.data };
}

export default router;
