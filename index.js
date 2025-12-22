require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

// Firebase Admin SDK for verifying JWT tokens
const admin = require("firebase-admin");
const serviceAccount = require("./book-courier-auth-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------------------------- MIDDLEWARE ---------------------------- //



// CORS configuration
app.use(
  cors({
    origin: ["http://localhost:5173", "https://book-courier-auth.web.app"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

// Middleware to parse incoming JSON requests
app.use(express.json());

// ---------------------------- JWT & ROLE VERIFICATION ---------------------------- //

// Verify Firebase JWT token
const verifyJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);

    req.tokenEmail = decoded.email;
    req.decoded = decoded;

    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized" });
  }
};

// ---------------------------- MONGODB CONNECTION ---------------------------- //

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhgpsyg.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Main async function to run DB operations
async function run() {
  try {
    // Connect to MongoDB and define collections
    const db = client.db("book-courier-db");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const sellerRequestsCollection = db.collection("sellerRequests");

    // Verify if user is ADMIN
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };

    // Verify if user is SELLER
    const verifySELLER = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "seller")
        return res
          .status(403)
          .send({ message: "Seller only Actions!", role: user?.role });

      next();
    };

    // <----------------------------< USER RELATED APIs >----------------------------> //

    // Create new user
    app.post("/users", async (req, res) => {
      try {
        const userData = req.body;
        userData.created_at = new Date().toISOString();
        userData.last_loggedIn = new Date().toISOString();
        userData.role = "customer";

        const query = { email: userData.email };
        const alreadyExists = await usersCollection.findOne(query);

        if (alreadyExists) {
          const result = await usersCollection.updateOne(query, {
            $set: { last_loggedIn: new Date().toISOString() },
          });
          return res.send({
            message: "User updated successfully",
            result,
          });
        }

        const result = await usersCollection.insertOne(userData);
        res.send({
          message: "User created successfully",
          result,
        });
      } catch (error) {
        console.error("User creation error:", error);
        res.status(500).send({ message: error.message });
      }
    });

    // Get user by email
    app.get("/users/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // Get all users (admin only)
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // Update user role by ID (for admin)
    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        [{ $set: { role: { $toLower: "$role" } } }]
      );

      res.send(result);
    });

    // Update user profile (name & image)
    app.patch("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { displayName, photoURL } = req.body;

        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              name: displayName,
              image: photoURL,
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // update a user's role
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role: role.toLowerCase() } }
      );
      await sellerRequestsCollection.deleteOne({ email });

      res.send(result);
    });

    // <----------------------------< BOOKS RELATED APIs >----------------------------> //

    // Get all books or filter by seller email
    app.get("/books", async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.email = email;
      }
      const cursor = booksCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Get first 6 published books for home page
    app.get("/home-books", async (req, res) => {
      const result = await booksCollection
        .find({ status: "published" })
        .limit(6)
        .toArray();

      res.send(result);
    });

    // Get single book by ID
    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Update book by ID
    app.patch("/books/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;
        delete updatedData._id;
        console.log("Update payload:", updatedData);

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Add new book (only seller)
    app.post("/books", verifyJWT, verifySELLER, async (req, res) => {
      const books = req.body;
      const result = await booksCollection.insertOne(books);
      res.send(result);
    });

    // <----------------------------< PAYMENT APIs >----------------------------> //

    // Create Stripe checkout session
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              product_data: {
                name: paymentInfo?.title,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100, // Amount in cents
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          bookId: paymentInfo?.bookId,
          customer: paymentInfo?.customer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/all-books/${paymentInfo?.bookId}`,
      });
      res.send({ url: session.url });
    });

    // Handle payment success and create order
    app.patch("/dashboard/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res
            .status(400)
            .send({ success: false, message: "No session id" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({
            success: false,
            message: "Payment not completed",
          });
        }

        const transactionId = session.payment_intent;

        const existingOrder = await ordersCollection.findOne({ transactionId });

        if (existingOrder) {
          console.log("Order already exists, skipping creation");
          return res.send({
            success: true,
            message: "Order already exists",
            orderId: existingOrder._id,
            isExisting: true,
          });
        }

        const bookId = new ObjectId(session.metadata.bookId);

        const book = await booksCollection.findOne({ _id: bookId });
        if (!book) {
          return res
            .status(404)
            .send({ success: false, message: "Book not found" });
        }

        if (book.quantity < 1) {
          return res.status(400).send({
            success: false,
            message: "Book is out of stock",
          });
        }

        // Update book quantity and payment status
        await booksCollection.updateOne(
          { _id: bookId },
          {
            $set: { paymentStatus: "paid" },
            $inc: { quantity: -1 },
          }
        );

        const orderInfo = {
          bookId: bookId,
          image: book.image,
          title: book.title,
          transactionId,
          customer: session.metadata.customer,
          status: "pending",
          seller: book.seller,
          category: book.category,
          quantity: 1,
          price: session.amount_total / 100,
          createdAt: new Date(),
        };

        const result = await ordersCollection.insertOne(orderInfo);

        console.log("New order created:", result.insertedId);

        res.send({
          success: true,
          message: "Order created successfully",
          orderId: result.insertedId,
          isExisting: false,
        });
      } catch (error) {
        console.error("Payment error:", error);
        res.status(500).send({
          success: false,
          message: "Error processing order",
          error: error.message,
        });
      }
    });

    // Get orders for logged-in user
    app.get("/dashboard/my-orders", verifyJWT, async (req, res) => {
      const result = await ordersCollection
        .find({ customer: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // Get payment success details by email
    app.get("/dashboard/my-orders/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;

      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const result = await ordersCollection.find({ customer: email }).toArray();

      res.send(result);
    });

    // <----------------------------< SELLER DASHBOARD >----------------------------> //

    // Get all orders for a seller
    app.get("/dashboard/manage-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // Get all inventory for a seller
    app.get("/dashboard/my-inventory/:email", async (req, res) => {
      const email = req.params.email;

      const result = await booksCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // Update order status
    app.patch("/orders/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );
      res.send(result);
    });

    // Cancel order
    app.delete("/orders/:id", async (req, res) => {
      const id = req.params.id;
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Update user role to Seller
    app.post("/become-seller", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      const alreadyExists = await sellerRequestsCollection.findOne({ email });

      if (alreadyExists)
        return res.status(409).send({ message: "Requested, please wait." });

      const result = await sellerRequestsCollection.insertOne({ email });
      res.send(result);
    });

    app.get("/seller-requests", verifyJWT, verifyADMIN, async (req, res) => {
      const requests = await sellerRequestsCollection.find().toArray();

      // Attach current role for each request
      const requestsWithRole = await Promise.all(
        requests.map(async (reqObj) => {
          const user = await usersCollection.findOne({ email: reqObj.email });
          return {
            ...reqObj,
            role: user?.role || "Pending",
            status: user?.role === "seller" ? "Accepted" : "Pending",
          };
        })
      );

      res.send(requestsWithRole);
    });

    app.get("/seller-request/status", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const exists = await sellerRequestsCollection.findOne({ email });
      res.send({ requested: !!exists });
    });

    app.delete(
      "/seller-request/:email",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        const email = req.params.email;
        const result = await sellerRequestsCollection.deleteOne({ email });
        res.send(result);
      }
    );

    app.patch(
      "/seller-requests/approve/:email",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        const email = req.params.email;

        await usersCollection.updateOne(
          { email },
          { $set: { role: "seller" } }
        );

        await sellerRequestsCollection.deleteOne({ email });

        res.send({ message: "Seller approved successfully" });
      }
    );

    // Ping MongoDB to confirm connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensure client closes when finished (optional)
    // await client.close();
  }
}
run().catch(console.dir);

// ---------------------------- DEFAULT ROUTE ---------------------------- //

app.get("/", (req, res) => {
  res.send("Book Courier Server is Running on port!");
});

// Start the server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
