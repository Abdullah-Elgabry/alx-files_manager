/* eslint-disable import/no-named-as-default */
import sha1 from 'sha1';
import Queue from 'bull/lib/queue';
import dbClient from '../utils/db';

const userQueue = new Queue('email sending');

/**
 * The UsersController handles user-related operations, 
 * such as creating new users and retrieving user information.
 */
export default class UsersController {
  /**
   * Creates a new user in the system. The user must provide an email and a password.
   * If the email is already registered, an error response is sent.
   * @param {Request} req The Express request object containing the user's email and password.
   * @param {Response} res The Express response object used to return the status and data.
   * @returns {void}
   */
  static async postNew(req, res) {
    const email = req.body ? req.body.email : null;
    const password = req.body ? req.body.password : null;

    if (!email) {
      res.status(400).json({ error: 'Missing email' });
      return;
    }
    if (!password) {
      res.status(400).json({ error: 'Missing password' });
      return;
    }
    const user = await (await dbClient.usersCollection()).findOne({ email });

    if (user) {
      res.status(400).json({ error: 'Already exist' });
      return;
    }
    const insertionInfo = await (await dbClient.usersCollection())
      .insertOne({ email, password: sha1(password) });
    const userId = insertionInfo.insertedId.toString();

    userQueue.add({ userId });
    res.status(201).json({ email, id: userId });
  }

  /**
   * Retrieves the current logged-in user's information, including their email and ID.
   * @param {Request} req The Express request object containing the authenticated user's information.
   * @param {Response} res The Express response object used to send back the user's details.
   * @returns {void}
   */
  static async getMe(req, res) {
    const { user } = req;

    res.status(200).json({ email: user.email, id: user._id.toString() });
  }
}
