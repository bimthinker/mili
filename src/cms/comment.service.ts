import * as _ from 'lodash';
import * as marked from 'marked';
import * as moment from 'moment';
import { Injectable } from '@nestjs/common';
import { Repository, Not, In, LessThan } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Comment,
    CommentContentType,
    CommentStatus,
    ChapterComment,
} from '../entity/comment.entity';
import { CreateCommentDto } from './dto/create-comment.dto';
import { NO_PARENT, CommentConstants } from '../constants/constants';
import { ErrorCode } from '../constants/error';
import { recentTime } from '../utils/viewfilter';
import { MyHttpException } from '../core/exception/my-http.exception';

const { CommentTypeArticle, CommentTypeChapter } = CommentConstants;
const userLikeTableMap = {
    [CommentTypeArticle]: 'userlikecomments',
    [CommentTypeChapter]: 'userlikechapter_comments',
};

const commentTableMap = {
    [CommentTypeArticle]: 'comments',
    [CommentTypeChapter]: 'chapter_comments',
};

const articleTableMap = {
    [CommentTypeArticle]: 'articles',
    [CommentTypeChapter]: 'book_chapters',
};

const commentListSelect = {
    id: true,
    createdAt: true,
    htmlContent: true,
    parentID: true,
    rootID: true,
    subIDs: true,
    user: {
        id: true,
        username: true,
        avatarURL: true,
        job: true,
        company: true,
    },
    likedCount: true,
    commentCount: true,
};

@Injectable()
export class CommentService {
    constructor(
        @InjectRepository(Comment)
        private readonly commentRepository: Repository<Comment>,

        @InjectRepository(ChapterComment)
        private readonly chapterCommentRepository: Repository<ChapterComment>,
    ) {}

    async findOne(commentType: string, commentID: number, select) {
        let comment;
        if (commentType === CommentTypeArticle) {
            comment = await this.commentRepository.findOne({
                id: commentID,
            }, {
                select,
            });
        } else if (commentType === CommentTypeChapter) {
            comment = await this.chapterCommentRepository.findOne({
                id: commentID,
            }, {
                select,
            });
        }
        return comment;
    }

    async getParent(commentType: string, id: number, fields = []) {
        if (commentType === CommentTypeArticle) {
            return await this.commentRepository.findOne({
                select: fields,
                where: {
                    id,
                },
            });
        }
        return await this.chapterCommentRepository.findOne({
            select: fields,
            where: {
                id,
            },
        });
    }

    async articleComments(articleID: number, lastCommentID: number, limit: number) {
        let comments = await this.commentRepository.find({
            select: commentListSelect,
            relations: ['user'],
            where: lastCommentID ? {
                articleID,
                parentID: NO_PARENT,
                id: LessThan(lastCommentID),
            } : {
                articleID,
                parentID: NO_PARENT,
            },
            order: { id: 'DESC' },
            take: limit,
        });
        comments = comments || [];
        // 一级评论
        const parentComments = comments.map(comment => {
            return {
                ...comment,
                subIDs: JSON.parse(comment.subIDs) as number[],
                comments: [],
                createdAtLabel: recentTime(comment.createdAt, 'YYYY.MM.DD'),
            };
        });
        let subCommentIDs = [];
        parentComments.map(pComment => subCommentIDs = subCommentIDs.concat(pComment.subIDs));
        const subComments = await this.articleSubCommentByIDs(subCommentIDs);
        const subCommentMap = {};
        subComments.map(s => subCommentMap[s.id] = s);
        parentComments.map(comment => {
            comment.comments = comment.subIDs.map(id => subCommentMap[id]);
        });
        return parentComments;
    }

    async articleSubComments(commentID: number, lastSubCommentID: number, limit: number) {
        let comments = await this.commentRepository.find({
            select: commentListSelect,
            relations: ['user'],
            where: { rootID: commentID, id: LessThan(lastSubCommentID) },
            order: { id: 'DESC' },
            take: limit,
        });
        comments = comments || [];
        const result = comments.map(comment => {
            return {
                ...comment,
                createdAtLabel: recentTime(comment.createdAt, 'YYYY.MM.DD'),
            };
        });
        return result;
    }

    async articleSubCommentByIDs(ids: number[]) {
        let comments = await this.commentRepository.find({
            select: commentListSelect,
            relations: ['user'],
            where: { id: In(ids) },
            order: { id: 'DESC' },
        });
        comments = comments || [];
        const result = comments.map(comment => {
            return {
                ...comment,
                createdAtLabel: recentTime(comment.createdAt, 'YYYY.MM.DD'),
            };
        });
        return result;
    }

    async create(commentType: string, createCommentDto: CreateCommentDto, userID: number) {
        let comment: Comment;
        if (commentType === CommentTypeArticle) {
            comment = new Comment();
        } else if (commentType === CommentTypeChapter) {
            comment = new ChapterComment();
        }
        comment.articleID = createCommentDto.commentTo;
        comment.contentType = CommentContentType.HTML;
        comment.htmlContent = createCommentDto.content;
        comment.parentID = createCommentDto.parentID || NO_PARENT;
        comment.rootID = createCommentDto.rootID || NO_PARENT;
        comment.status = CommentStatus.Verifying;
        comment.userID = userID;
        comment.createdAt = new Date();
        comment.updatedAt = comment.createdAt;
        comment.commentCount = 0;

        await this.commentRepository.manager.connection.transaction(async manager => {
            let sql = `UPDATE articles SET comment_count = comment_count + 1 WHERE id = ${comment.articleID}`;
            if (commentType === CommentTypeChapter) {
                sql = `UPDATE book_chapters SET comment_count = comment_count + 1 WHERE id = ${comment.articleID}`;
            }
            let commentRepository: any = manager.getRepository(Comment);
            if (commentType === CommentTypeChapter) {
                commentRepository = manager.getRepository(ChapterComment);
            }
            const commentData: any = { ...comment };
            if (commentType === CommentTypeChapter) {
                commentData.bookID = createCommentDto.bookID;
            }
            await commentRepository.save(commentData);
            await manager.query(sql);
            if (commentType === CommentTypeChapter) {
                await manager.query('UPDATE books SET comment_count = comment_count + 1 WHERE id = ?', [createCommentDto.bookID]);
            }
        });
        return comment;
    }

    async delete(commentType: string, commentID: number, userID: number) {
        const userLikeTable = userLikeTableMap[commentType];
        const commentTable = commentTableMap[commentType];
        const articleTable = articleTableMap[commentType];

        const comment = await this.findOne(commentType, commentID, ['id', 'articleID', 'parentID', 'rootID']);
        if (!comment) {
            throw new MyHttpException({
                errorCode: ErrorCode.ParamsError.CODE,
            });
        }
        if (comment.userID !== userID) {
            throw new MyHttpException({
                errorCode: ErrorCode.Forbidden.CODE,
            });
        }
        await this.commentRepository.manager.connection.transaction(async manager => {
            let sql1 = `DELETE FROM ${commentTable} WHERE id = ${commentID}`;
            let sql2 = `DELETE FROM ${userLikeTable} WHERE comment_id = ${commentID}`;
            if (!comment.parentID) {
                sql1 = `DELETE FROM ${commentTable} WHERE id = ${commentID} or root_id = ${commentID}`;
                sql2 = `DELETE FROM ${userLikeTable} WHERE comment_id = ${commentID} or root_id = ${commentID}`;
            }
            const deleteResult = await manager.query(sql1);
            await manager.query(sql2);
            const sql3 = `UPDATE ${articleTable} SET comment_count = comment_count - ${deleteResult.affectedRows} WHERE id = ${comment.articleID}`;
            await manager.query(sql3);
        });
    }

    // articleID是个冗余字段，为了方便查询用户在某篇文章下点过赞的所有评论
    async like(commentType: string, commentID: number, userID: number) {
        const comment = await this.findOne(commentType, commentID, ['id', 'articleID', 'parentID', 'rootID']);
        if (!comment) {
            throw new MyHttpException({
                errorCode: ErrorCode.ParamsError.CODE,
            });
        }

        const userLikeTable = userLikeTableMap[commentType];
        const commentTable = commentTableMap[commentType];

        const articleID = comment.articleID;
        const parentID = comment.parentID || NO_PARENT;
        const rootID = comment.rootID || NO_PARENT;
        const sql = `SELECT comment_id, user_id FROM ${userLikeTable}
            WHERE comment_id = ${commentID} AND user_id = ${userID}`;
        let result = await this.commentRepository.manager.query(sql);
        result = result || [];
        if (result.length) {
            throw new MyHttpException({
                errorCode: ErrorCode.ParamsError.CODE,
                message: '已经赞过此评论',
            });
        }
        await this.commentRepository.manager.connection.transaction(async manager => {
            const sql2 = `INSERT INTO ${userLikeTable} (comment_id, user_id, created_at, article_id, parent_id, root_id)
                VALUES(${commentID}, ${userID}, "${moment(new Date()).format('YYYY.MM.DD HH:mm:ss')}", ${articleID},
                ${parentID}, ${rootID})`;
            const sql3 = `UPDATE ${commentTable} SET liked_count = liked_count + 1 WHERE id = ${commentID}`;
            await manager.query(sql2);
            await manager.query(sql3);
        });
    }

    async deleteLike(commentType: string, commentID: number, userID: number) {
        const userLikeTable = userLikeTableMap[commentType];
        const commentTable = commentTableMap[commentType];

        const sql = `SELECT comment_id, user_id FROM ${userLikeTable}
            WHERE comment_id = ${commentID} AND user_id = ${userID}`;
        let result = await this.commentRepository.manager.query(sql);
        result = result || [];
        if (result.length <= 0) {
            throw new MyHttpException({
                errorCode: ErrorCode.ParamsError.CODE,
                message: '您还没有赞过此评论哦',
            });
        }
        await this.commentRepository.manager.connection.transaction(async manager => {
            const sql2 = `DELETE FROM ${userLikeTable}
                WHERE comment_id = ${commentID} AND user_id = ${userID}`;
            const sql3 = `UPDATE ${commentTable} SET liked_count = liked_count - 1 WHERE id = ${commentID}`;
            await manager.query(sql2);
            await manager.query(sql3);
        });

        return result;
    }

    // 文章或章节下用户点过赞的评论
    // 不传 userID 的话，是未登录用户，直接返回 []
    async userLikesInArticle(commentType: string, articleID: number, userID: number) {
        if (!userID) {
            return [];
        }
        const table = {
            [CommentTypeArticle]: 'userlikecomments',
            [CommentTypeChapter]: 'userlikechapter_comments',
        }[commentType];
        const sql = `SELECT comment_id as commentID FROM ${table}
            WHERE article_id = ${articleID} AND user_id = ${userID}`;
        let result = await this.commentRepository.manager.query(sql);
        result = result || [];
        return result;
    }
}