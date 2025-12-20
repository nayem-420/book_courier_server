const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhgpsyg.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db("book-courier-db");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");

    //   user related API's
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;

        const existingUser = await usersCollection.findOne({
          email: user.email,
        });

        if (existingUser) {
          return res.send({
            success: true,
            message: "User already exists",
            insertedId: existingUser._id,
          });
        }

        // Create new user
        const newUser = {
          ...user,
          role: "Customer",
          createdAt: new Date(),
        };

        const result = await usersCollection.insertOne(newUser);

        res.send({
          success: true,
          message: "User created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Error creating user",
          error: error.message,
        });
      }
    });

    // Get user by email
    app.get("/users/role/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email: email });

        if (!user) {
          return res.status(404).send({
            success: false,
            message: "User not found",
          });
        }

        res.send(user);
      } catch (error) {
        res.status(500).send({
          role: result?.role,
          success: false,
          message: "Error fetching user",
          error: error.message,
        });
      }
    });

    // update user profile
    app.patch("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { name, image } = req.body;

        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              name,
              image,
              updatedAt: new Date(),
            },
          }
        );

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    //   books related API's
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

    app.get("/home-books", async (req, res) => {
      const result = await booksCollection
        .find({ status: "published" })
        .limit(6)
        .toArray();

      res.send(result);
    });

    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

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

    app.post("/books", async (req, res) => {
      const books = req.body;
      const result = await booksCollection.insertOne(books);
      res.send(result);
    });

    //   payment related API's
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              product_data: {
                name: paymentInfo?.title,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
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

        // Book update
        await booksCollection.updateOne(
          { _id: bookId },
          {
            $set: { paymentStatus: "paid" },
            $inc: { quantity: -1 },
          }
        );

        // Order create
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

    app.get("/dashboard/my-orders/:email", async (req, res) => {
      const email = req.params.email;

      const result = await ordersCollection.find({ customer: email }).toArray();
      res.send(result);
    });

    //   seller orders
    app.get("/dashboard/manage-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

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

    app.get("/dashboard/my-inventory/:email", async (req, res) => {
      const email = req.params.email;

      const result = await booksCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Book Courier Server is Running on port!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
