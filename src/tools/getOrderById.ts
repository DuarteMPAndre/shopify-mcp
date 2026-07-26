import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

import {
  handleToolError,
  edgesToNodes,
} from "../lib/toolUtils.js";
import { formatOrderSummary } from "../lib/formatters.js";

// Input accepted by this MCP tool.
const GetOrderByIdInputSchema = z.object({
  orderId: z.string().min(1),
});

type GetOrderByIdInput = z.infer<
  typeof GetOrderByIdInputSchema
>;

type Money = {
  amount: string;
  currencyCode: string;
};

type MoneySet = {
  shopMoney: Money;
};

type TrackingInfo = {
  number: string | null;
  company: string | null;
  url: string | null;
};

type Fulfillment = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  inTransitAt: string | null;
  estimatedDeliveryAt: string | null;
  trackingInfo: TrackingInfo[];
};

type Customer = {
  id: string;
  firstName: string | null;
  lastName: string | null;

  defaultEmailAddress: {
    emailAddress: string;
  } | null;

  defaultPhoneNumber: {
    phoneNumber: string;
  } | null;
};

type LineItemNode = {
  id: string;
  title: string;
  name: string;
  quantity: number;
  sku: string | null;

  originalTotalSet: MoneySet;

  variant: {
    id: string;
    title: string;
    sku: string | null;
  } | null;
};

type MetafieldNode = {
  id: string;
  namespace: string;
  key: string;
  value: string;
  type: string;
};

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;

  processedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  returnStatus: string | null;
  poNumber: string | null;

  discountCodes: string[];
  tags: string[];
  note: string | null;

  displayFinancialStatus: string;
  displayFulfillmentStatus: string;

  totalPriceSet: MoneySet;
  subtotalPriceSet: MoneySet;
  totalShippingPriceSet: MoneySet;
  totalTaxSet: MoneySet;
  currentTotalPriceSet: MoneySet;

  customer: Customer | null;

  shippingAddress: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;

  lineItems: {
    edges: Array<{
      node: LineItemNode;
    }>;
  };

  fulfillments: Fulfillment[];

  metafields: {
    edges: Array<{
      node: MetafieldNode;
    }>;
  };
};

type OrderResponse = {
  order: OrderNode | null;
};

type FindOrderResponse = {
  orders: {
    edges: Array<{
      node: {
        id: string;
      };
    }>;
  };
};

// This extracts the exact input type expected by formatOrderSummary.
// We do not need access to its private RawOrderNode interface.
type FormatterOrderInput = Parameters<
  typeof formatOrderSummary
>[0];

// Initialised from src/index.ts.
let shopifyClient: GraphQLClient;

const getOrderById = {
  name: "get-order-by-id",

  description:
    "Get a specific Shopify order by order number, numeric ID, or GraphQL ID. " +
    "Returns customer, payment, fulfilment, shipping, line-item, and shipment " +
    "tracking details including tracking numbers, carriers, and tracking URLs.",

  schema: GetOrderByIdInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetOrderByIdInput) => {
    try {
      const { orderId } = input;

      let resolvedId: string;
      const trimmed = orderId.trim();

      if (trimmed.startsWith("gid://")) {
        // Already a complete Shopify GraphQL ID.
        resolvedId = trimmed;
      } else if (/^#?\d{1,9}$/.test(trimmed)) {
        // Treat a short number such as 1128 or #1128
        // as the Shopify order name.
        const orderName = trimmed.startsWith("#")
          ? trimmed
          : `#${trimmed}`;

        const nameQuery = gql`
          #graphql

          query FindOrderByName($query: String!) {
            orders(first: 1, query: $query) {
              edges {
                node {
                  id
                }
              }
            }
          }
        `;

        const nameData =
          await shopifyClient.request<FindOrderResponse>(
            nameQuery,
            {
              query: `name:${orderName}`,
            },
          );

        if (nameData.orders.edges.length === 0) {
          throw new Error(
            `Order with name ${orderName} not found`,
          );
        }

        resolvedId =
          nameData.orders.edges[0].node.id;
      } else if (/^\d+$/.test(trimmed)) {
        // Treat a long numeric value as Shopify's
        // numeric Order resource ID.
        resolvedId =
          `gid://shopify/Order/${trimmed}`;
      } else {
        resolvedId = trimmed;
      }

      const query = gql`
        #graphql

        query GetOrderById($id: ID!) {
          order(id: $id) {
            id
            name
            createdAt
            updatedAt
            processedAt

            displayFinancialStatus
            displayFulfillmentStatus

            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            subtotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            totalShippingPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            totalTaxSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            customer {
              id
              firstName
              lastName

              defaultEmailAddress {
                emailAddress
              }

              defaultPhoneNumber {
                phoneNumber
              }
            }

            shippingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
              phone
            }

            billingAddress {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
              phone
            }

            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  name
                  quantity
                  sku

                  originalTotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }

                  variant {
                    id
                    title
                    sku
                  }
                }
              }
            }

            fulfillments(first: 20) {
              id
              name
              status
              createdAt
              updatedAt
              deliveredAt
              inTransitAt
              estimatedDeliveryAt

              trackingInfo(first: 20) {
                number
                company
                url
              }
            }

            tags
            note

            cancelReason
            cancelledAt
            returnStatus
            poNumber
            discountCodes

            metafields(first: 20) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }
      `;

      const data =
        await shopifyClient.request<OrderResponse>(
          query,
          {
            id: resolvedId,
          },
        );

      if (!data.order) {
        throw new Error(
          `Order with ID ${orderId} not found`,
        );
      }

      const order = data.order;

      /*
       * Build the precise object required by formatOrderSummary.
       *
       * Shopify can return null for firstName, lastName and SKU,
       * but the repository formatter expects strings. We normalise
       * those values before passing the data to the formatter.
       */
      const formatterInput: FormatterOrderInput = {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,

        displayFinancialStatus:
          order.displayFinancialStatus,
        displayFulfillmentStatus:
          order.displayFulfillmentStatus,

        totalPriceSet: order.totalPriceSet,
        subtotalPriceSet: order.subtotalPriceSet,
        totalShippingPriceSet:
          order.totalShippingPriceSet,
        totalTaxSet: order.totalTaxSet,

        customer: order.customer
          ? {
              id: order.customer.id,
              firstName:
                order.customer.firstName ?? "",
              lastName:
                order.customer.lastName ?? "",
              defaultEmailAddress:
                order.customer.defaultEmailAddress,
              defaultPhoneNumber:
                order.customer.defaultPhoneNumber,
            }
          : null,

        shippingAddress: order.shippingAddress,

        lineItems: {
          edges: order.lineItems.edges.map(
            ({ node }) => ({
              node: {
                id: node.id,
                title: node.title,
                quantity: node.quantity,
                originalTotalSet:
                  node.originalTotalSet,

                variant: node.variant
                  ? {
                      id: node.variant.id,
                      title: node.variant.title,
                      sku:
                        node.variant.sku ?? "",
                    }
                  : null,
              },
            }),
          ),
        },

        tags: order.tags,
        note: order.note,
      };

      const base =
        formatOrderSummary(formatterInput);

      const fulfillments = (
        order.fulfillments ?? []
      ).map((fulfillment) => {
        const trackingInfo = (
          fulfillment.trackingInfo ?? []
        ).map((item) => ({
          number: item.number ?? null,
          company: item.company ?? null,
          url: item.url ?? null,
        }));

        return {
          id: fulfillment.id,
          name: fulfillment.name,
          status: fulfillment.status,
          createdAt: fulfillment.createdAt,
          updatedAt: fulfillment.updatedAt,

          deliveredAt:
            fulfillment.deliveredAt ?? null,

          inTransitAt:
            fulfillment.inTransitAt ?? null,

          estimatedDeliveryAt:
            fulfillment.estimatedDeliveryAt ??
            null,

          trackingInfo,

          hasTrackingNumber:
            trackingInfo.some(
              (item) =>
                typeof item.number ===
                  "string" &&
                item.number.trim().length > 0,
            ),
        };
      });

      /*
       * Flatten the tracking information so the ChatGPT agent
       * can find it easily without navigating nested objects.
       */
      const tracking = fulfillments.flatMap(
        (fulfillment) =>
          fulfillment.trackingInfo.map(
            (item) => ({
              fulfillmentId:
                fulfillment.id,
              fulfillmentName:
                fulfillment.name,
              fulfillmentStatus:
                fulfillment.status,
              number: item.number,
              company: item.company,
              url: item.url,
            }),
          ),
      );

      const usableTracking = tracking.filter(
        (item) =>
          Boolean(item.number) ||
          Boolean(item.company) ||
          Boolean(item.url),
      );

      const formattedOrder = {
        ...base,

        customer: order.customer
          ? {
              ...base.customer,

              firstName:
                order.customer.firstName ??
                "",

              lastName:
                order.customer.lastName ??
                "",

              phone:
                order.customer
                  .defaultPhoneNumber
                  ?.phoneNumber ?? null,
            }
          : null,

        shippingAddress:
          order.shippingAddress,

        billingAddress:
          order.billingAddress,

        cancelReason:
          order.cancelReason,

        cancelledAt:
          order.cancelledAt,

        updatedAt:
          order.updatedAt,

        returnStatus:
          order.returnStatus,

        processedAt:
          order.processedAt,

        poNumber:
          order.poNumber,

        discountCodes:
          order.discountCodes,

        currentTotalPrice:
          order.currentTotalPriceSet
            .shopMoney,

        fulfillments,

        // The easiest field for the agent to inspect.
        tracking: usableTracking,

        hasTrackingInformation:
          usableTracking.length > 0,

        trackingMessage:
          usableTracking.length > 0
            ? "Tracking information is available in the tracking field."
            : "Shopify returned no tracking number, carrier, or tracking URL for this order's fulfillments.",

        metafields:
          edgesToNodes(order.metafields),
      };

      return {
        order: formattedOrder,
      };
    } catch (error) {
      return handleToolError(
        "fetch order",
        error,
      );
    }
  },
};

export { getOrderById };