const WebSocket = require("ws");

const FCS_SOCKET_KEY =
  process.env.FCS_SOCKET_API_KEY;

const FCS_URL =
  "wss://ws-v4.fcsapi.com/ws";

const TROY_OUNCE_GRAMS =
  31.1034768;

let goldUsd = null;
let usdInr = null;

let goldTimestamp = null;
let fxTimestamp = null;

let fcsSocket = null;

let clients = new Set();

let reconnectTimer = null;

function calculateGoldINR() {
  if (
    !Number.isFinite(goldUsd) ||
    !Number.isFinite(usdInr)
  ) {
    return null;
  }

  return (
    goldUsd *
    usdInr
  ) / TROY_OUNCE_GRAMS;
}

function broadcast() {
  const price =
    calculateGoldINR();

  if (
    !Number.isFinite(price)
  ) {
    return;
  }

  const payload =
    JSON.stringify({
      type: "gold",

      priceInrPerGram:
        price,

      xauUsd:
        goldUsd,

      usdInr:
        usdInr,

      timestamp:
        Date.now(),
    });

  for (
    const client of clients
  ) {
    if (
      client.readyState === 1
    ) {
      client.send(payload);
    }
  }

  console.log(
    "LIVE GOLD:",
    price
  );
}

function handleFCSMessage(raw) {
  try {
    const data =
      JSON.parse(raw.toString());

    console.log(
      "FCS:",
      data
    );

    if (
      data.type !== "price"
    ) {
      return;
    }

    const symbol =
      String(
        data.symbol || ""
      ).toUpperCase();

    const prices =
      data.prices || {};

    const current =
      Number(prices.c);

    if (
      !Number.isFinite(current)
    ) {
      return;
    }

    /*
     * XAU/USD
     */

    if (
      symbol.includes(
        "XAUUSD"
      )
    ) {
      goldUsd =
        current;

      goldTimestamp =
        Date.now();

      broadcast();

      return;
    }

    /*
     * USD/INR
     */

    if (
      symbol.includes(
        "USDINR"
      )
    ) {
      usdInr =
        current;

      fxTimestamp =
        Date.now();

      broadcast();

      return;
    }

  } catch (error) {
    console.error(
      "FCS message error:",
      error
    );
  }
}

function connectFCS() {
  if (
    !FCS_SOCKET_KEY
  ) {
    console.error(
      "FCS_SOCKET_API_KEY is missing"
    );

    return;
  }

  console.log(
    "Connecting to FCS WebSocket..."
  );

  const url =
    `${FCS_URL}?access_key=${encodeURIComponent(
      FCS_SOCKET_KEY
    )}`;

  fcsSocket =
    new WebSocket(url);

  fcsSocket.on(
    "open",
    () => {
      console.log(
        "FCS WebSocket connected"
      );

      /*
       * FX symbols use the FX prefix
       * in FCS WebSocket subscriptions.
       */

      fcsSocket.send(
        JSON.stringify({
          action:
            "subscribe",

          symbols: [
            "FX:XAUUSD",
            "FX:USDINR",
          ],
        })
      );

      /*
       * Also support the current FCS
       * join-style protocol.
       */

      try {
        fcsSocket.send(
          JSON.stringify({
            type:
              "join_symbol",

            symbol:
              "FX:XAUUSD",

            timeframe:
              "1",
          })
        );

        fcsSocket.send(
          JSON.stringify({
            type:
              "join_symbol",

            symbol:
              "FX:USDINR",

            timeframe:
              "1",
          })
        );
      } catch (error) {
        console.error(
          "Subscription error:",
          error
        );
      }
    }
  );

  fcsSocket.on(
    "message",
    handleFCSMessage
  );

  fcsSocket.on(
    "error",
    (error) => {
      console.error(
        "FCS WebSocket error:",
        error.message
      );
    }
  );

  fcsSocket.on(
    "close",
    () => {
      console.log(
        "FCS WebSocket closed"
      );

      fcsSocket =
        null;

      if (
        reconnectTimer
      ) {
        clearTimeout(
          reconnectTimer
        );
      }

      reconnectTimer =
        setTimeout(() => {
          connectFCS();
        }, 5000);
    }
  );
}

function addClient(
  response
) {
  clients.add(
    response
  );

  response.on(
    "close",
    () => {
      clients.delete(
        response
      );
    }
  );

  response.write(
    `data: ${JSON.stringify({
      type: "status",
      connected:
        Boolean(
          fcsSocket &&
          fcsSocket.readyState === 1
        ),
    })}\n\n`
  );
}

function getCurrentGold() {
  const price =
    calculateGoldINR();

  return {
    priceInrPerGram:
      price,

    xauUsd:
      goldUsd,

    usdInr:
      usdInr,

    goldTimestamp:
      goldTimestamp,

    fxTimestamp:
      fxTimestamp,

    connected:
      Boolean(
        fcsSocket &&
        fcsSocket.readyState === 1
      ),
  };
}

function initializeGoldRate() {
  connectFCS();
}

module.exports = {
  initializeGoldRate,
  addClient,
  getCurrentGold,
};