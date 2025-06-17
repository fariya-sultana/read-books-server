require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB URI
const uri = `mongodb+srv://${process.env.READ_BOOKS_USER}:${process.env.READ_BOOKS_PASS}@cluster0.ry0n7jv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers?.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
    }
    catch (error) {
        return res.status(401).send({ message: 'unauthorized access' })
    }
}

async function run() {
    try {
        // await client.connect();

        const db = client.db('readBooks');
        const booksCollection = db.collection('books');
        const categoryCollection = db.collection('category');
        const borrowedBooksCollection = db.collection('borrowedBooks');

        app.get('/', (req, res) => {
            res.send(' Welcome to ReadBooks API');
        });

        // Get all categories
        app.get('/categories', async (req, res) => {
            try {
                const categories = await categoryCollection.find().toArray();
                res.send(categories);
            } catch (error) {
                res.status(500).send({ message: 'Failed to fetch categories' });
            }
        });

        // Get all books
        app.get('/books', async (req, res) => {
            const query = req.query.category ? { category: req.query.category } : {};
            try {
                const books = await booksCollection.find(query).toArray();
                res.send(books);
            } catch (error) {
                res.status(500).send({ message: 'Failed to fetch books' });
            }
        });

        // Get single book by ID
        app.get('/books/:id', async (req, res) => {
            const { id } = req.params;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'Invalid Book ID' });
            }
            try {
                const book = await booksCollection.findOne({ _id: new ObjectId(id) });
                if (!book) return res.status(404).send({ message: 'Book not found' });
                res.send(book);
            } catch (error) {
                res.status(500).send({ message: 'Failed to fetch book' });
            }
        });

        // Add a new book
        app.post('/books', async (req, res) => {
            const newBook = req.body;
            const requiredFields = ['name', 'image', 'author', 'category', 'description', 'rating', 'quantity'];
            const missing = requiredFields.filter(field => !newBook[field]);

            if (missing.length > 0) {
                return res.status(400).send({ message: `Missing fields: ${missing.join(', ')}` });
            }

            try {
                const result = await booksCollection.insertOne(newBook);
                res.send({ insertedId: result.insertedId });
            } catch (error) {
                res.status(500).send({ message: 'Failed to add book' });
            }
        });

        //  Update a book by ID
        app.put('/books/:id', async (req, res) => {
            const { id } = req.params;
            const updatedData = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'Invalid Book ID' });
            }

            try {
                const result = await booksCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updatedData }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: 'Book not found' });
                }

                res.send({ message: 'Book updated successfully' });
            } catch (error) {
                console.error(' Update error:', error);
                res.status(500).send({ message: 'Failed to update book' });
            }
        });

        // POST /borrow/:id
        app.post('/borrow/:id', async (req, res) => {
            const { name, email, returnDate } = req.body;
            const bookId = req.params.id;

            // Validate ObjectId
            if (!ObjectId.isValid(bookId)) {
                return res.status(400).json({ message: 'Invalid book ID' });
            }

            try {
                const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });

                if (!book || book.quantity <= 0) {
                    return res.status(400).json({ message: 'Book not available.' });
                }

                // if user already borrowed this book and hasn’t returned it
                const alreadyBorrowed = await borrowedBooksCollection.findOne({
                    email,
                    bookId: new ObjectId(bookId),
                });

                if (alreadyBorrowed) {
                    return res.status(400).json({ message: 'You have already borrowed this book.' });
                }

                // Decrement quantity
                await booksCollection.updateOne(
                    { _id: new ObjectId(bookId), quantity: { $gt: 0 } },
                    { $inc: { quantity: -1 } }
                );

                // Save borrowing record
                await borrowedBooksCollection.insertOne({
                    bookId: new ObjectId(bookId),
                    name,
                    email,
                    returnDate,
                    borrowedAt: new Date(),
                    title: book.name,
                    image: book.image,
                    category: book.category,
                });

                res.json({ message: 'Book borrowed successfully' });
            } catch (error) {
                console.error('Borrow error:', error);
                res.status(500).json({ message: 'Failed to borrow book' });
            }
        });





        // GET /borrowed?email=user@example.com
        app.get('/borrowed', verifyFirebaseToken, async (req, res) => {
            const { email } = req.query;

            if (!email) return res.status(400).json({ message: 'Email required' });

            if (email !== req.decoded.email) {
                return res.status(403).message({ message: 'forbidden access' })
            }

            try {
                const borrowed = await borrowedBooksCollection.find({ email }).toArray();
                res.json(borrowed);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch borrowed books' });
            }
        });

        // DELETE /return/:borrowId
        app.delete('/return/:borrowId', async (req, res) => {
            const { borrowId } = req.params;

            try {
                const borrowEntry = await borrowedBooksCollection.findOne({ _id: new ObjectId(borrowId) });

                if (!borrowEntry) {
                    return res.status(404).json({ message: 'Borrow record not found' });
                }

                // Increment book quantity
                await booksCollection.updateOne(
                    { _id: new ObjectId(borrowEntry.bookId) },
                    { $inc: { quantity: 1 } }
                );

                // Remove from borrowedBooks
                await borrowedBooksCollection.deleteOne({ _id: new ObjectId(borrowId) });

                res.json({ message: 'Book returned successfully' });
            } catch (error) {
                console.error('Return error:', error);
                res.status(500).json({ message: 'Failed to return book' });
            }
        });



    } catch (err) {
        console.error(' Connection Error:', err);
    }
}

run().catch(console.dir);

app.listen(port, () => {
    console.log(` Server running at http://localhost:${port}`);
});
