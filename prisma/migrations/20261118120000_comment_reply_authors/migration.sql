-- CreateTable
CREATE TABLE "CommentReplyAuthor" (
    "replyId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "fromAccount" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentReplyAuthor_pkey" PRIMARY KEY ("replyId")
);

-- CreateIndex
CREATE INDEX "CommentReplyAuthor_instagramAccountId_idx" ON "CommentReplyAuthor"("instagramAccountId");

-- AddForeignKey
ALTER TABLE "CommentReplyAuthor" ADD CONSTRAINT "CommentReplyAuthor_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

