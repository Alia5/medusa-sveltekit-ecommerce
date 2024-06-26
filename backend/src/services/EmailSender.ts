import { AbstractNotificationService, FulfillmentService, GiftCardService, Logger, OrderService, ReturnedData } from '@medusajs/medusa';
import { EntityManager } from 'typeorm';
import nodemailer from 'nodemailer';
import { Order } from 'src/models/order';


interface PasswordResetPayload {
    id: string; // string ID of customer
    email: string; // string email of the customer
    first_name: string; // string first name of the customer
    last_name: string; // string last name of the customer
    token: string; // string reset password token
}

const MAIL_FROM = '"Fred FooBar 👻" <daren.koch@ethereal.email>';

export default class EmailSenderService extends AbstractNotificationService {

    public static identifier = 'email-sender';
    protected manager: EntityManager;
    protected transactionManager: EntityManager;
    protected orderService: OrderService;
    protected fulfillmentService: FulfillmentService;
    protected logger: Logger;
    protected mailer: nodemailer.Transporter;
    protected giftCardService: GiftCardService;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public constructor(container: Record<string, unknown>, options: Record<string, unknown>) {
        super(container);
        this.logger = container.logger as Logger;
        this.orderService = container.orderService as OrderService;
        this.fulfillmentService = container.fulfillmentService as FulfillmentService;
        this.giftCardService = container.giftCardService as GiftCardService;

        this.mailer = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number.parseInt(process.env.SMTP_PORT, 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendNotification(event: string, data: Record<string, unknown>, attachmentGenerator: unknown): Promise<ReturnedData> {
        let order: Order;
        switch (event) {
            case 'order.placed': {
                if (!data.id) {
                    throw new Error('No order id');
                }
                order = await this.orderService.retrieve(data.id as string, {
                    relations: ['fulfillments', 'fulfillments.tracking_links', 'invoice']
                }) as Order;
                return this.sendOrderEmail(order);
            }
            case 'order.shipment_created':
                if (!data.id) {
                    throw new Error('No order id');
                }
                order = await this.orderService.retrieve(data.id as string, {
                    relations: ['fulfillments', 'fulfillments.tracking_links', 'invoice']
                }) as Order;
                return this.sendShippingEmail(order);
            case 'customer.password_reset':
                return this.sendPasswordResetEmail(data as unknown as PasswordResetPayload);
            case GiftCardService.Events.CREATED:
                this.logger.info(`GIFTCREATED, ${JSON.stringify(data)}`);
                return;
            case 'order.payment_captured':
                order = await this.orderService.retrieve(data.id as string, {
                    relations: ['fulfillments', 'fulfillments.tracking_links', 'items', 'gift_cards']
                }) as Order;
                return this.handlePaymentCaptureForGiftCards(order);
            default:
                break;

        }
        throw new Error('Received event not subscribed to');
    }
    public async resendNotification(
        notification: Record<string, unknown>,
        config: { to: string } | null | undefined,
        attachmentGenerator: unknown
    ): Promise<ReturnedData> {
        let order: Order;
        const data = notification.data as Record<string, unknown> & {
            orderId: string;
        };
        switch (notification.event_name) {
            case 'order.placed': {
                if (!data.orderId) {
                    throw new Error('No order id');
                }
                order = await this.orderService.retrieve(data.orderId, {
                    relations: ['fulfillments', 'fulfillments.tracking_links', 'invoice']
                }) as Order;
                return this.sendOrderEmail(order, config?.to);
            }
            case 'order.shipment_created':
                if (!data.orderId) {
                    throw new Error('No order id');
                }
                order = await this.orderService.retrieve(data.orderId, {
                    relations: ['fulfillments', 'fulfillments.tracking_links', 'invoice']
                }) as Order;
                return this.sendShippingEmail(order, config?.to);
            case GiftCardService.Events.CREATED:
                this.logger.info(`GIFTCREATED, ${JSON.stringify(data)}`);
                return;
            case 'order.payment_captured':
                order = await this.orderService.retrieve(data.id as string, {
                    relations: ['fulfillments', 'fulfillments.tracking_links', 'items', 'gift_cards']
                }) as Order;
                return this.handlePaymentCaptureForGiftCards(order);
            return;
            default:
                break;

        }
        throw new Error('Received event not subscribed to');
    }

    protected async handlePaymentCaptureForGiftCards(order: Order, to?: string): Promise<ReturnedData> {
        this.logger.info(`Handling payment capture for gift cards ${JSON.stringify(order)}`);

        const giftCards = await this.giftCardService.list({order_id: order.id});

        await Promise.all(giftCards.map(async (card) => {
                // ?email strips the layout and only returns the email body
                const page = await fetch(`${process.env.STORE_URL}/gift-card/${card.code}?email=true`);
                const html = (await page.text()).replace(/<script(.|\n)*?<\/script>/g, '');
                return this.mailer.sendMail({
                    from: MAIL_FROM,
                    to: to || order.email,
                    subject: 'Your gift card 🎁',
                    html
                });
        }));

        if (order.items?.every((oi) => oi.is_giftcard)) {
            this.orderService.completeOrder(order.id);
        }

        return {
            to: to || order.email,
            status: 'done',
            data: {
                orderId: order.id,
                order
            }
        };
    }

    protected async sendPasswordResetEmail(payload: PasswordResetPayload): Promise<ReturnedData> {
        this.logger.info(`Sending password reset email ${JSON.stringify(payload)}`);
        const result = await this.mailer.sendMail({
            from: MAIL_FROM,
            to: payload.email,
            subject: 'Password reset',
            html: `Hi ${payload.first_name} ${payload.last_name},\n<br />\n`
            + `You can reset your password by following this <a href="${
                process.env.STORE_URL}/account/reset/${payload.token}?email=${payload.email}">link</a>`
        });
        return {
            to: payload.email,
            status: 'done',
            data: {
                email: payload.email,
                mailerResult: result
            }
        };
    }

    protected async sendOrderEmail(order: Order, to?: string): Promise<ReturnedData> {
        const { invoice, ...normalizedOrder } = order;
        this.logger.info(`Sending order email ${JSON.stringify(normalizedOrder)}`);

        // ?email strips the layout and only returns the email body
        const page = await fetch(`${process.env.STORE_URL}/checkout/success/${order.id}?email=true`);
        const html = (await page.text()).replace(/<script(.|\n)*?<\/script>/g, '');

        const result = await this.mailer.sendMail({
            from: MAIL_FROM,
            to: to || order.email,
            subject: 'Order confirmation 📦',
            html: html,
            attachments: order.invoice?.pdf ? [
                {
                    filename: `invoice-${order.invoice.invoice_number}.pdf`,
                    content: order.invoice?.pdf
                }
            ] : []
        });

        return {
            to: to || order.email,
            status: 'done',
            data: {
                orderId: order.id,
                mailerResult: result
            }
        };
    }

    protected async sendShippingEmail(order: Order, to?: string): Promise<ReturnedData> {
        const { invoice, ...normalizedOrder } = order;

        this.logger.info(`Sending shipment email ${JSON.stringify(normalizedOrder)}`);

        let mailText = "Your order has been shipped!\n\n"

        order.fulfillments.forEach((fulfillment) => {
            fulfillment.tracking_links.forEach((tl) => {
                const trackingUrl = tl.url || tl.tracking_number.startsWith("http") ? tl.tracking_number : null;
                if (trackingUrl) {
                    mailText += `${trackingUrl}\n`
                }
            })
        });

        if (mailText.includes("http")) {
            mailText = mailText.replace(
                "Your order has been shipped!\n\n",
                 "Your order has been shipped!\n\nYou can track your order here:\n"
                )
        }

        const result = await this.mailer.sendMail({
            from: MAIL_FROM,
            to: to || order.email,
            subject: 'Your order has been shipped! 📦🚀🎉',
            text: mailText
        });

        return {
            to: to || order.email,
            status: 'done',
            data: {
                orderId: order.id,
                mailerResult: result
            }
        };
    }

}
