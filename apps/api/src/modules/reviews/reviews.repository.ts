import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/db';

export interface ReviewRow extends RowDataPacket {
  id: number;
  contract_id: number;
  reviewer_id: number;
  reviewee_id: number;
  rating: number;
  comment: string | null;
  created_at: Date;
}

export interface ReviewListRow extends ReviewRow {
  response: string | null;
}

export const reviewsRepository = {
  async findById(id: number): Promise<ReviewRow | undefined> {
    const [rows] = await pool.query<ReviewRow[]>(
      `SELECT id, contract_id, reviewer_id, reviewee_id, rating, comment, created_at
         FROM reviews WHERE id = :id LIMIT 1`,
      { id },
    );
    return rows[0];
  },

  async findByContractId(contractId: number): Promise<ReviewRow | undefined> {
    const [rows] = await pool.query<ReviewRow[]>(
      `SELECT id, contract_id, reviewer_id, reviewee_id, rating, comment, created_at
         FROM reviews WHERE contract_id = :contractId LIMIT 1`,
      { contractId },
    );
    return rows[0];
  },

  async listForReviewee(revieweeId: number, limit: number, offset: number): Promise<ReviewListRow[]> {
    const [rows] = await pool.query<ReviewListRow[]>(
      `SELECT r.id, r.contract_id, r.reviewer_id, r.reviewee_id, r.rating, r.comment, r.created_at,
              rr.response
         FROM reviews r
         LEFT JOIN review_responses rr ON rr.review_id = r.id
        WHERE r.reviewee_id = :revieweeId AND r.is_public = 1
        ORDER BY r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      { revieweeId },
    );
    return rows;
  },

  /** Insere a avaliação e recalcula a nota média do freelancer na MESMA transação (RN-044). */
  async create(data: {
    contractId: number;
    reviewerId: number;
    revieweeId: number;
    rating: number;
    comment: string | null;
  }): Promise<number> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [res] = await conn.query<ResultSetHeader>(
        `INSERT INTO reviews (contract_id, reviewer_id, reviewee_id, rating, comment)
         VALUES (:contractId, :reviewerId, :revieweeId, :rating, :comment)`,
        data,
      );
      await conn.query<ResultSetHeader>(
        `UPDATE profiles_freelancer
            SET avg_rating = (
                  SELECT COALESCE(AVG(rating), 0) FROM reviews
                   WHERE reviewee_id = :revieweeId AND is_public = 1
                ),
                total_reviews = (
                  SELECT COUNT(*) FROM reviews
                   WHERE reviewee_id = :revieweeId AND is_public = 1
                )
          WHERE user_id = :revieweeId`,
        { revieweeId: data.revieweeId },
      );
      await conn.commit();
      return res.insertId;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async findResponseByReviewId(reviewId: number): Promise<{ id: number } | undefined> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM review_responses WHERE review_id = :reviewId LIMIT 1`,
      { reviewId },
    );
    return rows[0] as { id: number } | undefined;
  },

  async createResponse(reviewId: number, userId: number, response: string): Promise<void> {
    await pool.query<ResultSetHeader>(
      `INSERT INTO review_responses (review_id, user_id, response)
       VALUES (:reviewId, :userId, :response)`,
      { reviewId, userId, response },
    );
  },
};
